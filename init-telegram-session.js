import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import input from 'input'
import fs from 'fs'


const apiId = parseInt(await input.text('Введите ваш TELEGRAM_API_ID: '))
const apiHash = await input.text('Введите ваш TELEGRAM_API_HASH: ')


const stringSession = new StringSession('')


async function main() {
console.log('Запуск клиента...')
const client = new TelegramClient(stringSession, apiId, apiHash, { connectionRetries: 5 })
await client.start({
phoneNumber: async () => await input.text('Введите ваш номер телефона: '),
password: async () => await input.text('Введите ваш пароль (если есть): '),
phoneCode: async () => await input.text('Введите код из Telegram (вам придет в сообщении): '),
onError: (err) => console.log(err),
})
console.log('✅ Вы успешно вошли!')
console.log('👉 Вот ваша session строка (StringSession):')
console.log(client.session.save())
fs.writeFileSync('session.json', client.session.save(), 'utf8')
console.log('💾 Сессия сохранена в session.json (не коммитить!)')
}


main()