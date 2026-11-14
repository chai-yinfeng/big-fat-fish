// Declaration only (see ../index.js): data, no behaviour.
// A text-only channel that exists for tests and staging replay (deploy/staging/fake-channel.mjs is its bridge and is
// not part of a release). It stands for a channel driven from outside: its receipts are not reliable.
export default {
  id: 'mock', title: 'MOCK',
  expression: { voice: false, images: false, faces: false, split: false },
  friends: true, account: '^MOCK-[A-Z0-9-]{1,24}$',
  receipts: 'unreliable',
  faceNames: [],
  prompt: '这段私聊在一个只能发文字的测试渠道（MOCK-CHANNEL）里：这里没有语音、图片和小表情。',
  turnPolicy: {},
  testOnly: true,
};
