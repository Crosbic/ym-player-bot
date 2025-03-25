import { ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder } from 'discord.js'

import { TokenStoreService } from '../services/token-store.service.js'
import { IUserData } from '../types/userData.js'

export const data = new SlashCommandBuilder()
  .setName('account-info')
  .setDescription('Отобразить данные, полученные от Яндекса')

export async function execute(interaction: ChatInputCommandInteraction) {
  const userDiscordId = interaction.user.id
  const userData: IUserData | undefined = TokenStoreService.getInstance().getData(userDiscordId)?.userInfo

  if (!userData) {
    return interaction.reply({
      content: 'Вы не авторизованы! Используйте команду /login для входа в Яндекс Музыку',
      ephemeral: true
    })
  }

  const userEmbed = new EmbedBuilder()
    .setColor('#86cecb')
    .setTitle('Информация о вашем аккаунте Яндекс')
    .setThumbnail(`https://avatars.mds.yandex.net/get-yapic/${userData.avatarUrl}/islands-retina-50`)
    .addFields(
      {
        name: 'Имя пользователя',
        value: userData.fullName || 'Нет данных',
        inline: true
      },
      { name: 'Ник', value: userData.nickName, inline: true },
      { name: 'Плюс', value: userData.hasPlus ? 'активен' : 'отсутствует', inline: true }
    )
    .setFooter({
      text: 'My Wave Bot'
    })
    .setTimestamp()

  return interaction.reply({ embeds: [userEmbed], ephemeral: true })
}
