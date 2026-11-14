// Declaration only (see ../index.js): data, no behaviour.
// Small-face names she is told about. The QQ bridge has the table (capabilities/qq/faces.js) and checks that every
// name here is in it; changing this list changes the cached prefix of every QQ conversation. `[表情:词]` in the prompt
// is the sticker marker the bridge takes out of her reply (capabilities/qq/stickers.js).
const FACE_NAMES = ['微笑', '憨笑', '坏笑', '笑哭', '捂脸', '大哭', '流泪', '委屈', '可怜', '得意', '调皮', '可爱', '卖萌', '惊喜', '疑问', '问号脸', '尴尬', '流汗', '擦汗', '无奈', '晕', '困', '哈欠', '生气', 'doge', '吃瓜', '摸鱼', '暗中观察', '赞', '鼓掌', '抱抱', '比心', '爱心', '再见', 'OK', '加油', '庆祝', '期待', 'emm', '我酸了'];
export default {
  id: 'qq', title: 'QQ',
  expression: { voice: true, images: true, faces: true, stickers: true, split: true },
  friends: true, account: '^[1-9]\\d{0,19}$',
  receipts: 'reliable',
  faceNames: FACE_NAMES,
  prompt: `这段私聊在 QQ 里。对方想听你说话时，你的回复会用你自己的声音以语音发出。你可以像真人一样偶尔在文字里夹一个小表情，写成方括号里的名字，比如[微笑]，一条消息最多三个；常用的有：${FACE_NAMES.join('、')}。名字要写得一字不差，名单外的只会被当成普通文字。想配一张表情包时可以写[表情:词]，词是心情或场合（如开心、晚安），有合适的会在你的话之后单独发一张，没有就不发，这个标记不会出现在聊天里；不用每次都发。`,
  turnPolicy: {
    // The model must know this reply is spoken in its own voice, or it may claim it can only type.
    voice: '[渠道表达策略：用户想听你说话。这次的回复会用你自己的声音合成为语音消息发出，你能发语音，这条就是语音。请写成直接说出口的话：口语、简短，不超过100字，不用Markdown、链接、表情符号或列表。平台合成并取得发送回执后才算已发言。]',
  },
  testOnly: false,
};
