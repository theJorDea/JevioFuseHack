export default {
  id: 'idle-loader-status',
  task: 'When the terminal is idle, show the ready status only once and no spinner, both on startup and after submitting a message. Keep animated thinking feedback while the request is pending.',
  files: {
    base: [['src/interactive-tui.ts', 'base-interactive-tui.ts.fixture', '7d712b276ef82863ca77b02b9be2a5cf14d5c94adda09f3d8c14e99ba9234242']],
    gold: [['src/interactive-tui.ts', 'gold-interactive-tui.ts.fixture', 'e9697c8efd1471a8fe56b797be1e7f6f9c52aae0133273d82ee048adc398dcef']],
  },
  probeSha256: '075c56abf681c61eba9a52cdeb436221a89f9e7464ecf0ba5aec71f482dd310e',
};
