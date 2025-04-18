import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  NoSubscriberBehavior,
  StreamType,
  AudioPlayer,
  VoiceConnection,
  AudioResource
} from '@discordjs/voice'
import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ComponentType
} from 'discord.js'
import { YandexMusicService, ITrackInfo } from './yandex-music.service.js'
import { IYandexTrack } from '../types/yandexTrack.js'

export interface PlayerOptions {
  interaction: ChatInputCommandInteraction
  voiceChannel: any
  accessToken: string
  userId: string
  stationId: string
}

export interface PlayerState {
  isPlaying: boolean
  currentTrack: ITrackInfo | null
  previousTracks: IYandexTrack[]
  trackQueue: IYandexTrack[]
  accessToken: string
  userId: string
  stationId: string
  embedMessage: Message | undefined
  trackStartTime: number | null // Время начала воспроизведения текущего трека
  retryCount: number // Счетчик повторных попыток воспроизведения текущего трека
  lastTrackId: string | null // ID последнего воспроизведенного трека
}

export class PlayerService {
  private static instance: PlayerService
  private yandexMusicService: YandexMusicService
  private players: Map<string, AudioPlayer> = new Map()
  private connections: Map<string, VoiceConnection> = new Map()
  private playerStates: Map<string, PlayerState> = new Map()
  private currentResources: Map<string, AudioResource> = new Map()

  private constructor() {
    this.yandexMusicService = YandexMusicService.getInstance()
  }

  public static getInstance(): PlayerService {
    if (!PlayerService.instance) {
      PlayerService.instance = new PlayerService()
    }
    return PlayerService.instance
  }

  /**
   * Создание и настройка плеера для воспроизведения треков
   */
  public async createPlayer(options: PlayerOptions): Promise<{
    player: AudioPlayer
    connection: VoiceConnection
    embedMessage: Message | undefined
  }> {
    const { interaction, voiceChannel, accessToken, userId, stationId } = options
    const guildId = interaction.guild!.id

    // Присоединяемся к голосовому каналу
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guildId,
      adapterCreator: interaction.guild!.voiceAdapterCreator
    })

    // Создаем аудио плеер
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Play
      }
    })

    // Подписываем соединение на плеер
    connection.subscribe(player)

    // Ожидаем успешного подключения к каналу
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 5_000)
    } catch (connectionError) {
      connection.destroy()
      throw new Error('Не удалось подключиться к голосовому каналу')
    }

    // Обработка ошибок соединения
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000)
        ])
        // Если мы дошли до этой точки, значит соединение пытается восстановиться
      } catch (error) {
        // Если мы дошли до этой точки, соединение не может быть восстановлено
        connection.destroy()
        this.players.delete(guildId)
        this.connections.delete(guildId)
        this.playerStates.delete(guildId)
        this.currentResources.delete(guildId)
      }
    })

    // Создаем embed для отображения информации о треке
    const embed = new EmbedBuilder()
      .setColor('#FFCC00')
      .setTitle('🎵 Сейчас играет')
      .setDescription('Загрузка трека...')
      .setFooter({ text: 'Яндекс Музыка - Моя волна' })
      .setTimestamp()

    // Создаем кнопки управления
    const row = this.createControlButtons(true)

    // Проверяем, что канал является текстовым каналом, который поддерживает отправку сообщений
    let embedMessage: Message | undefined
    if (interaction.channel && 'send' in interaction.channel) {
      // Отправляем embed, который будем обновлять
      embedMessage = await interaction.channel.send({
        embeds: [embed],
        components: [row]
      })

      // Настраиваем обработчик кнопок
      this.setupButtonHandler(embedMessage, guildId)
    }

    // Сохраняем плеер и соединение
    this.players.set(guildId, player)
    this.connections.set(guildId, connection)

    // Инициализируем состояние плеера
    this.playerStates.set(guildId, {
      isPlaying: false,
      currentTrack: null,
      previousTracks: [],
      trackQueue: [],
      accessToken,
      userId,
      stationId,
      embedMessage,
      trackStartTime: null,
      retryCount: 0,
      lastTrackId: null
    })

    return { player, connection, embedMessage }
  }

  /**
   * Создание кнопок управления
   */
  private createControlButtons(isPlaying: boolean): ActionRowBuilder<ButtonBuilder> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('like').setLabel('👍').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('previous').setLabel('⏮️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(isPlaying ? 'pause' : 'play')
        .setLabel(isPlaying ? '⏸️' : '▶️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('stop').setLabel('⏹️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('next').setLabel('⏭️').setStyle(ButtonStyle.Secondary)
    )

    return row
  }

  /**
   * Настройка обработчика кнопок
   */
  private setupButtonHandler(message: Message, guildId: string) {
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 3600000 // 1 час
    })

    collector.on('collect', async (interaction: ButtonInteraction) => {
      // Проверяем, что плеер существует
      const player = this.players.get(guildId)
      const playerState = this.playerStates.get(guildId)

      if (!player || !playerState) {
        await interaction.reply({
          content: 'Плеер не найден или уже остановлен.',
          ephemeral: true
        })
        return
      }

      // Обрабатываем нажатие кнопки
      switch (interaction.customId) {
        case 'like':
          await this.handleLike(interaction, guildId)
          break
        case 'previous':
          await this.handlePrevious(interaction, guildId)
          break
        case 'pause':
          await this.handlePause(interaction, guildId)
          break
        case 'play':
          await this.handlePlay(interaction, guildId)
          break
        case 'stop':
          await this.handleStop(interaction, guildId)
          break
        case 'next':
          await this.handleNext(interaction, guildId)
          break
      }
    })

    collector.on('end', () => {
      // Удаляем кнопки после истечения времени коллектора
      if (message.editable) {
        message.edit({ components: [] }).catch(console.error)
      }
    })
  }

  /**
   * Обработка нажатия кнопки "Лайк"
   */
  private async handleLike(interaction: ButtonInteraction, guildId: string) {
    const playerState = this.playerStates.get(guildId)
    if (!playerState || !playerState.currentTrack) {
      await interaction.reply({
        content: 'Нет текущего трека для лайка.',
        ephemeral: true
      })
      return
    }

    try {
      // Отправляем запрос на добавление трека в список понравившихся
      const success = await this.yandexMusicService.likeTrack(
        playerState.accessToken,
        playerState.userId,
        playerState.currentTrack.id
      )

      if (success) {
        await interaction.reply({
          content: `Трек "${playerState.currentTrack.title}" добавлен в список понравившихся!`,
          ephemeral: true
        })
      } else {
        await interaction.reply({
          content: 'Не удалось добавить трек в список понравившихся.',
          ephemeral: true
        })
      }
    } catch (error) {
      console.error('Ошибка при отправке лайка:', error)
      await interaction.reply({
        content: 'Произошла ошибка при отправке лайка.',
        ephemeral: true
      })
    }
  }

  /**
   * Обработка нажатия кнопки "Предыдущий трек"
   */
  private async handlePrevious(interaction: ButtonInteraction, guildId: string) {
    const playerState = this.playerStates.get(guildId)
    const player = this.players.get(guildId)

    if (!playerState || !player) {
      await interaction.reply({
        content: 'Плеер не найден или уже остановлен.',
        ephemeral: true
      })
      return
    }

    if (playerState.previousTracks.length === 0) {
      await interaction.reply({
        content: 'Нет предыдущих треков для воспроизведения.',
        ephemeral: true
      })
      return
    }

    try {
      // Берем последний трек из истории
      const previousTrack = playerState.previousTracks.pop()

      if (previousTrack) {
        // Если есть текущий трек, добавляем его в начало очереди
        if (playerState.currentTrack) {
          const currentTrackAsYandexTrack: IYandexTrack = {
            id: playerState.currentTrack.id,
            title: playerState.currentTrack.title,
            artists: [{ name: playerState.currentTrack.artist }],
            albums: [{ title: playerState.currentTrack.album }],
            coverUri: playerState.currentTrack.coverUrl?.replace('https://', '').replace('400x400', '%%') || ''
          }

          playerState.trackQueue.unshift(currentTrackAsYandexTrack)
        }

        // Воспроизводим предыдущий трек
        const trackInfo = this.yandexMusicService.trackToTrackInfo(previousTrack)
        await this.playTrack(
          player,
          trackInfo,
          playerState.accessToken,
          playerState.stationId,
          playerState.embedMessage
        )

        await interaction.reply({
          content: 'Воспроизведение предыдущего трека.',
          ephemeral: true
        })
      }
    } catch (error) {
      console.error('Ошибка при воспроизведении предыдущего трека:', error)
      await interaction.reply({
        content: 'Произошла ошибка при воспроизведении предыдущего трека.',
        ephemeral: true
      })
    }
  }

  /**
   * Обработка нажатия кнопки "Пауза"
   */
  private async handlePause(interaction: ButtonInteraction, guildId: string) {
    const player = this.players.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !playerState) {
      await interaction.reply({
        content: 'Плеер не найден или уже остановлен.',
        ephemeral: true
      })
      return
    }

    try {
      player.pause()
      playerState.isPlaying = false

      // Обновляем кнопки
      if (playerState.embedMessage && playerState.embedMessage.editable) {
        const row = this.createControlButtons(false)
        await playerState.embedMessage.edit({ components: [row] })
      }

      await interaction.reply({
        content: 'Воспроизведение приостановлено.',
        ephemeral: true
      })
    } catch (error) {
      console.error('Ошибка при приостановке воспроизведения:', error)
      await interaction.reply({
        content: 'Произошла ошибка при приостановке воспроизведения.',
        ephemeral: true
      })
    }
  }

  /**
   * Обработка нажатия кнопки "Воспроизведение"
   */
  private async handlePlay(interaction: ButtonInteraction, guildId: string) {
    const player = this.players.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !playerState) {
      await interaction.reply({
        content: 'Плеер не найден или уже остановлен.',
        ephemeral: true
      })
      return
    }

    try {
      player.unpause()
      playerState.isPlaying = true

      // Обновляем кнопки
      if (playerState.embedMessage && playerState.embedMessage.editable) {
        const row = this.createControlButtons(true)
        await playerState.embedMessage.edit({ components: [row] })
      }

      await interaction.reply({
        content: 'Воспроизведение возобновлено.',
        ephemeral: true
      })
    } catch (error) {
      console.error('Ошибка при возобновлении воспроизведения:', error)
      await interaction.reply({
        content: 'Произошла ошибка при возобновлении воспроизведения.',
        ephemeral: true
      })
    }
  }

  /**
   * Обработка нажатия кнопки "Стоп"
   */
  private async handleStop(interaction: ButtonInteraction, guildId: string) {
    const player = this.players.get(guildId)
    const connection = this.connections.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !connection || !playerState) {
      await interaction.reply({
        content: 'Плеер не найден или уже остановлен.',
        ephemeral: true
      })
      return
    }

    try {
      // Останавливаем воспроизведение и отключаемся от канала
      player.stop()
      connection.destroy()

      // Удаляем плеер и соединение из карт
      this.players.delete(guildId)
      this.connections.delete(guildId)
      this.playerStates.delete(guildId)
      this.currentResources.delete(guildId)

      // Обновляем сообщение
      if (playerState.embedMessage && playerState.embedMessage.editable) {
        const stoppedEmbed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('⏹️ Воспроизведение остановлено')
          .setDescription('Плеер был остановлен.')
          .setFooter({ text: 'Яндекс Музыка - Моя волна' })
          .setTimestamp()

        await playerState.embedMessage.edit({ embeds: [stoppedEmbed], components: [] })
      }

      await interaction.reply({
        content: 'Воспроизведение остановлено.',
        ephemeral: true
      })
    } catch (error) {
      console.error('Ошибка при остановке воспроизведения:', error)
      await interaction.reply({
        content: 'Произошла ошибка при остановке воспроизведения.',
        ephemeral: true
      })
    }
  }

  /**
   * Обработка нажатия кнопки "Следующий трек"
   */
  private async handleNext(interaction: ButtonInteraction, guildId: string) {
    const player = this.players.get(guildId)
    const playerState = this.playerStates.get(guildId)

    if (!player || !playerState) {
      await interaction.reply({
        content: 'Плеер не найден или уже остановлен.',
        ephemeral: true
      })
      return
    }

    try {
      // Эмитируем событие Idle, чтобы запустить следующий трек
      player.emit(AudioPlayerStatus.Idle)

      await interaction.reply({
        content: 'Переход к следующему треку.',
        ephemeral: true
      })
    } catch (error) {
      console.error('Ошибка при переходе к следующему треку:', error)
      await interaction.reply({
        content: 'Произошла ошибка при переходе к следующему треку.',
        ephemeral: true
      })
    }
  }

  /**
   * Обновление embed с информацией о треке
   */
  public updateEmbed(message: Message | undefined, trackInfo: ITrackInfo) {
    if (!message) return

    const updatedEmbed = new EmbedBuilder()
      .setColor('#FFCC00')
      .setTitle('🎵 Сейчас играет')
      .setDescription(`**${trackInfo.title}**\nИсполнитель: ${trackInfo.artist}\nАльбом: ${trackInfo.album}`)
      .setFooter({ text: 'Яндекс Музыка - Моя волна' })
      .setTimestamp()

    if (trackInfo.coverUrl) {
      updatedEmbed.setThumbnail(trackInfo.coverUrl)
    }

    message.edit({ embeds: [updatedEmbed] }).catch((error: Error) => {
      console.error('Ошибка при обновлении embed:', error)
    })
  }

  /**
   * Обновление embed с сообщением об ошибке
   */
  public updateEmbedWithError(message: Message | undefined, errorMessage: string) {
    if (!message) return

    const errorEmbed = new EmbedBuilder()
      .setColor('#FF0000')
      .setTitle('⚠️ Ошибка')
      .setDescription(errorMessage)
      .setFooter({ text: 'Яндекс Музыка - Моя волна' })
      .setTimestamp()

    message.edit({ embeds: [errorEmbed] }).catch((error: Error) => {
      console.error('Ошибка при обновлении embed с ошибкой:', error)
    })
  }

  /**
   * Воспроизведение трека
   */
  public async playTrack(
    player: AudioPlayer,
    trackInfo: ITrackInfo,
    accessToken: string,
    stationId: string,
    embedMessage: Message | undefined
  ): Promise<boolean> {
    try {
      // Обновляем embed с информацией о загрузке трека
      if (embedMessage) {
        const loadingEmbed = new EmbedBuilder()
          .setColor('#FFCC00')
          .setTitle('🎵 Загрузка трека')
          .setDescription(
            `**${trackInfo.title}**\nИсполнитель: ${trackInfo.artist}\nАльбом: ${trackInfo.album}\n\nЗагрузка...`
          )
          .setFooter({ text: 'Яндекс Музыка - Моя волна' })
          .setTimestamp()

        if (trackInfo.coverUrl) {
          loadingEmbed.setThumbnail(trackInfo.coverUrl)
        }

        await embedMessage.edit({ embeds: [loadingEmbed] }).catch((error: Error) => {
          console.error('Ошибка при обновлении embed с информацией о загрузке:', error)
        })
      }

      // Отправляем фидбэк о начале воспроизведения трека
      await this.yandexMusicService.sendTrackStartedFeedback(accessToken, stationId, trackInfo.id)

      // Получаем URL для стриминга трека
      console.log(`Получение URL для трека: ${trackInfo.title}`)
      const streamUrl = await this.yandexMusicService.getStreamUrl(accessToken, trackInfo.id)
      if (!streamUrl) {
        console.log('Не удалось получить URL для трека')
        if (embedMessage) {
          this.updateEmbedWithError(embedMessage, `Не удалось получить URL для трека: ${trackInfo.title}`)
        }
        return false
      }

      // Создаем ресурс напрямую из URL
      console.log(`Создание ресурса для трека: ${trackInfo.title}`)
      const resource = createAudioResource(streamUrl, {
        inputType: StreamType.Arbitrary
      })

      // Сохраняем ресурс и информацию о текущем треке
      const guildId = embedMessage?.guild?.id
      if (guildId) {
        this.currentResources.set(guildId, resource)

        const playerState = this.playerStates.get(guildId)
        if (playerState) {
          // Если есть текущий трек, добавляем его в историю
          if (playerState.currentTrack) {
            const currentTrackAsYandexTrack: IYandexTrack = {
              id: playerState.currentTrack.id,
              title: playerState.currentTrack.title,
              artists: [{ name: playerState.currentTrack.artist }],
              albums: [{ title: playerState.currentTrack.album }],
              coverUri: playerState.currentTrack.coverUrl?.replace('https://', '').replace('400x400', '%%') || ''
            }

            // Ограничиваем историю 10 треками
            if (playerState.previousTracks.length >= 10) {
              playerState.previousTracks.shift()
            }

            playerState.previousTracks.push(currentTrackAsYandexTrack)
          }

          // Обновляем текущий трек
          playerState.currentTrack = trackInfo
          playerState.isPlaying = true

          // Обновляем кнопки
          if (playerState.embedMessage && playerState.embedMessage.editable) {
            const row = this.createControlButtons(true)
            await playerState.embedMessage.edit({ components: [row] })
          }
        }
      }

      // Воспроизводим аудио
      console.log(`Начало воспроизведения трека: ${trackInfo.title}`)
      player.play(resource)

      // Обновляем embed с информацией о треке
      this.updateEmbed(embedMessage, trackInfo)

      // Устанавливаем время начала воспроизведения трека
      const playerState = this.playerStates.get(guildId as any)
      if (playerState) {
        playerState.trackStartTime = Date.now()
        // Проверяем, что id не undefined и не null
        if (trackInfo.id) {
          playerState.lastTrackId = trackInfo.id
        } else {
          playerState.lastTrackId = null
        }
        playerState.retryCount = 0 // Сбрасываем счетчик повторных попыток
      }

      return true
    } catch (error) {
      console.error('Ошибка при воспроизведении трека:', error)
      if (embedMessage) {
        this.updateEmbedWithError(embedMessage, `Ошибка при воспроизведении трека: ${trackInfo.title}`)
      }
      return false
    }
  }

  /**
   * Настройка бесконечного воспроизведения треков
   */
  public setupInfinitePlayback(
    player: AudioPlayer,
    accessToken: string,
    stationId: string,
    embedMessage: Message | undefined,
    initialTracks: IYandexTrack[]
  ) {
    const guildId = embedMessage?.guild?.id
    if (!guildId) return

    // Обновляем очередь треков в состоянии плеера
    const playerState = this.playerStates.get(guildId)
    if (playerState) {
      playerState.trackQueue = [...initialTracks]
    }

    // Функция для загрузки новых треков
    const loadMoreTracks = async () => {
      try {
        console.log('Загружаем новые треки для очереди...')
        const newTracks = await this.yandexMusicService.getStationTracks(accessToken, stationId)

        const playerState = this.playerStates.get(guildId)
        if (playerState && newTracks && newTracks.length > 0) {
          // Добавляем все новые треки в очередь
          playerState.trackQueue.push(...newTracks)
          console.log(`Добавлено ${newTracks.length} новых треков в очередь`)
          return true
        }
        return false
      } catch (error) {
        console.error('Ошибка при загрузке новых треков:', error)
        return false
      }
    }

    // Удаляем все предыдущие обработчики событий, чтобы избежать дублирования
    player.removeAllListeners(AudioPlayerStatus.Idle)
    player.removeAllListeners('error')

    // Флаг для отслеживания, находимся ли мы в процессе загрузки трека
    let isLoadingTrack = false

    // Минимальное время воспроизведения трека в миллисекундах (10 секунд)
    // Если трек играл меньше этого времени, считаем что это было прерывание, а не завершение
    const MIN_PLAY_TIME = 10000

    // Максимальное количество повторных попыток воспроизведения трека
    const MAX_RETRY_COUNT = 3

    // Обработчик ошибок воспроизведения
    player.on('error', error => {
      console.error('Ошибка воспроизведения:', error)

      const playerState = this.playerStates.get(guildId)
      if (!playerState || !playerState.currentTrack) return

      // Обновляем embed с информацией об ошибке
      if (embedMessage) {
        const errorEmbed = new EmbedBuilder()
          .setColor('#FFA500') // Оранжевый цвет для временных ошибок
          .setTitle('⚠️ Проблема с воспроизведением')
          .setDescription(
            `Возникла проблема при воспроизведении трека "${playerState.currentTrack.title}". Пытаемся восстановить...`
          )
          .setFooter({ text: 'Яндекс Музыка - Моя волна' })
          .setTimestamp()

        embedMessage.edit({ embeds: [errorEmbed] }).catch((error: Error) => {
          console.error('Ошибка при обновлении embed с ошибкой:', error)
        })
      }

      // Пытаемся повторно воспроизвести текущий трек через 3 секунды
      setTimeout(() => {
        if (playerState.retryCount < MAX_RETRY_COUNT && playerState.currentTrack) {
          console.log(
            `Повторная попытка воспроизведения трека: ${playerState.currentTrack.title} (попытка ${playerState.retryCount + 1}/${MAX_RETRY_COUNT})`
          )
          playerState.retryCount++
          this.playTrack(player, playerState.currentTrack, accessToken, stationId, embedMessage)
        } else {
          // Если превышено максимальное количество попыток, переходим к следующему треку
          console.log('Превышено максимальное количество попыток, переходим к следующему треку')
          isLoadingTrack = false
          player.emit(AudioPlayerStatus.Idle)
        }
      }, 3000)
    })

    // Обработчик для воспроизведения следующего трека
    player.on(AudioPlayerStatus.Idle, async () => {
      const playerState = this.playerStates.get(guildId)
      if (!playerState) return

      // Если мы уже в процессе загрузки трека, игнорируем событие
      if (isLoadingTrack) {
        console.log('Уже идет загрузка трека, игнорируем событие Idle')
        return
      }

      // Проверяем, не было ли это кратковременное прерывание
      const currentTime = Date.now()
      const playTime = playerState.trackStartTime ? currentTime - playerState.trackStartTime : 0

      // Если трек играл меньше минимального времени и у нас есть текущий трек,
      // пытаемся повторно воспроизвести его
      if (playTime < MIN_PLAY_TIME && playerState.currentTrack && playerState.retryCount < MAX_RETRY_COUNT) {
        console.log(
          `Обнаружено прерывание воспроизведения трека: ${playerState.currentTrack.title} после ${playTime}ms`
        )
        console.log(`Повторная попытка воспроизведения (${playerState.retryCount + 1}/${MAX_RETRY_COUNT})`)

        // Обновляем embed с информацией о повторной попытке
        if (embedMessage) {
          const reconnectEmbed = new EmbedBuilder()
            .setColor('#FFA500') // Оранжевый цвет для временных ошибок
            .setTitle('🔄 Восстановление соединения')
            .setDescription(`Восстанавливаем воспроизведение трека "${playerState.currentTrack.title}"...`)
            .setFooter({ text: 'Яндекс Музыка - Моя волна' })
            .setTimestamp()

          if (playerState.currentTrack.coverUrl) {
            reconnectEmbed.setThumbnail(playerState.currentTrack.coverUrl)
          }

          embedMessage.edit({ embeds: [reconnectEmbed] }).catch((error: Error) => {
            console.error('Ошибка при обновлении embed с информацией о восстановлении:', error)
          })
        }

        // Увеличиваем счетчик повторных попыток
        playerState.retryCount++

        // Ждем 3 секунды перед повторной попыткой
        setTimeout(() => {
          if (playerState.currentTrack) {
            this.playTrack(player, playerState.currentTrack, accessToken, stationId, embedMessage)
          }
        }, 3000)

        return
      }

      // Если это не прерывание или превышено максимальное количество попыток,
      // переходим к следующему треку
      console.log('Трек закончился, проверяем очередь')
      console.log(`Треков в очереди: ${playerState.trackQueue.length}`)

      if (playerState.trackQueue.length > 0) {
        // Устанавливаем флаг загрузки
        isLoadingTrack = true

        try {
          // Берем следующий трек из очереди
          const nextTrack = playerState.trackQueue.shift()
          if (nextTrack) {
            console.log(`Подготовка к воспроизведению следующего трека: ${nextTrack.title}`)
            const nextTrackInfo = this.yandexMusicService.trackToTrackInfo(nextTrack)

            const success = await this.playTrack(player, nextTrackInfo, accessToken, stationId, embedMessage)
            if (!success) {
              console.log(`Не удалось воспроизвести трек: ${nextTrack.title}, ждем 3 секунды перед следующей попыткой`)

              // Если не удалось воспроизвести трек, ждем 3 секунды перед следующей попыткой
              setTimeout(() => {
                isLoadingTrack = false
                player.emit(AudioPlayerStatus.Idle)
              }, 3000)
            } else {
              // Если трек успешно воспроизведен, сбрасываем флаг загрузки
              isLoadingTrack = false
            }
          } else {
            isLoadingTrack = false
          }
        } catch (error) {
          console.error('Ошибка при воспроизведении следующего трека:', error)
          isLoadingTrack = false
        }
      } else {
        console.log('Очередь пуста, загружаем новые треки')

        // Устанавливаем флаг загрузки
        isLoadingTrack = true

        try {
          const loaded = await loadMoreTracks()
          if (loaded) {
            // Если удалось загрузить новые треки, запускаем воспроизведение через 1 секунду
            setTimeout(() => {
              isLoadingTrack = false
              player.emit(AudioPlayerStatus.Idle)
            }, 1000)
          } else {
            console.log('Не удалось загрузить новые треки, завершаем воспроизведение')
            if (embedMessage) {
              const finalEmbed = new EmbedBuilder()
                .setColor('#FF0000')
                .setTitle('⚠️ Воспроизведение завершено')
                .setDescription('Не удалось загрузить новые треки.')
                .setFooter({ text: 'Яндекс Музыка - Моя волна' })
                .setTimestamp()

              embedMessage.edit({ embeds: [finalEmbed], components: [] }).catch((error: Error) => {
                console.error('Ошибка при обновлении embed:', error)
              })
            }
            isLoadingTrack = false
          }
        } catch (error) {
          console.error('Ошибка при загрузке новых треков:', error)
          isLoadingTrack = false
        }
      }
    })
  }
}
