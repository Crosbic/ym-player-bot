import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

import { Client, Collection, Events, GatewayIntentBits } from 'discord.js'

import config from './config.js'

// Получение директории текущего модуля
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Расширение типов Client для добавления коллекции команд
declare module 'discord.js' {
  interface Client {
    commands: Collection<string, any>
  }
}

// Определение интентов (разрешений) для бота
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
})

// Инициализация коллекции команд
client.commands = new Collection()

// Загрузка команд
const commandsPath = path.join(__dirname, 'commands')
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter(file => file.endsWith('.js') || file.endsWith('.ts'))

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file)
  // Используем динамический импорт для ESM
  const command = await import(`file://${filePath}`)

  // Устанавливаем новую команду в коллекцию клиента
  if ('data' in command && 'execute' in command) {
    client.commands.set(command.data.name, command)
  } else {
    console.log(
      `[ПРЕДУПРЕЖДЕНИЕ] Команда в ${filePath} отсутствует обязательное свойство "data" или "execute".`
    )
  }
}

// Загрузка обработчиков событий
const eventsPath = path.join(__dirname, 'events')
const eventFiles = fs
  .readdirSync(eventsPath)
  .filter(file => file.endsWith('.js') || file.endsWith('.ts'))

for (const file of eventFiles) {
  const filePath = path.join(eventsPath, file)
  const event = await import(`file://${filePath}`)

  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args))
  } else {
    client.on(event.name, (...args) => event.execute(...args))
  }
}

// Обработка слеш-команд
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return

  const command = client.commands.get(interaction.commandName)

  if (!command) {
    console.error(`Команда ${interaction.commandName} не найдена.`)
    return
  }

  try {
    await command.execute(interaction)
  } catch (error) {
    console.error(error)

    const replyOptions = {
      content: 'Произошла ошибка при выполнении команды!',
      ephemeral: true
    }

    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyOptions)
    } else {
      await interaction.reply(replyOptions)
    }
  }
})

// Обработка события готовности
client.once(Events.ClientReady, readyClient => {
  console.log(`Бот запущен как ${readyClient.user.tag}`)
})

// Подключение бота к Discord
client.login(config.token).then(_ => console.log('Логин по токену успешен'))
