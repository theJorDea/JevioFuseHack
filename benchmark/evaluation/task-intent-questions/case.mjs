export default {
  id: 'task-intent-questions',
  task: 'Questions about how existing software works can be mistaken for requests to change it. Correct the intent classification while preserving recognition of direct implementation requests.',
  files: {
    base: [['src/task-intent.ts', 'base-task-intent.ts.fixture', '03212a4ad581bded98fe65a04d3e9c08393f18cdb0027180808f19ad4aa5de23']],
    gold: [['src/task-intent.ts', 'gold-task-intent.ts.fixture', '6d02d0d3431b479135d52b17f85acdaf5b32c0c6f60a8ad4d4dce790d5cdc1dc']],
  },
  probeSha256: 'f9c09763ac7cfb32bc1882af651f1a0a1dcbb0d53a67bf3b71b687d5d7553b75',
};
