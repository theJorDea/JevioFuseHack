export default {
  id: 'web-reload-busy',
  task: 'Reloading the web chat during a running task can leave the composer ready to send and omit the in-progress message. Restore the active conversation state on opening the page while keeping idle sessions usable.',
  files: {
    base: [['web/app.js', 'base-app.js.fixture', 'c5e04e3c6ec78d2c5d1857646d2200c096b5cef7e711cce8a1db5bbd5566f099']],
    gold: [['web/app.js', 'gold-app.js.fixture', '2cede69fbaaa1dc558a2e84fef40cd190bebba0757444232f3525773df0cab0e']],
  }, probeSha256: '67940f20e40581f9a221c41c7b591ef5308f9b1ec617ee34613f87c4cd558c52',
};
