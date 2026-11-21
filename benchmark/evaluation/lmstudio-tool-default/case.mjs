export default {
  id: 'lmstudio-tool-default',
  task: 'An existing local LM Studio provider under a custom name loads without a suitable tool protocol. Make the local endpoint default work while preserving explicit protocol choices and unrelated endpoints.',
  files: {
    base: [['src/config.ts','base-config.ts.fixture','4fbcf178d312ddd2f60f9c63461306a48f60ddc360afc63591e0143c7b1c9645']],
    gold: [['src/config.ts','gold-config.ts.fixture','d78dbb2cc3848c041b2c5997035b8a1a1d8a47b9f5cc4ca6ca482d7682614066']],
  },
  probeSha256: '55cba4b1667274805f455f1ca1205dddca833dc0fd1bfc04c396d5adcc3122cc',
};
