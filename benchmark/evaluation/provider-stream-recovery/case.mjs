export default {
  id: 'provider-stream-recovery',
  task: 'Recover a chat completion when its response stream terminates by retrying the same request once without streaming. Keep successful requests streaming normally.',
  files: {
    base: [['src/provider/openai-compatible.ts', 'base-provider.ts.fixture', '79b2aad4fd49f03ddea336ae4955230f31cfbeb67863421017c0dcf9e39c5cba']],
    gold: [['src/provider/openai-compatible.ts', 'gold-provider.ts.fixture', 'fbd11fd027e8d21ff350b8a28a17c529e04956b1c2b1b03640d02a8757f8ed6b']],
  },
  probeSha256: '6741473661a003b3fc280a1e53aff25818392a4278e43aaa56b2677c14591ba0',
};
