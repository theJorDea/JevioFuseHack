const identity = ['src/project-identity.ts', 'project-identity.ts.fixture', '3e6c5cd230f365199e00f6fd1b42e024833171f90a2f954d209287bf1857d8da'];
export default {
  id: 'cognee-data-receipt', task: 'Preserve the addressable data record when a successful Cognee remember response identifies only the dataset. Keep direct receipts working.',
  files: {
    base: [['src/memory.ts', 'base-memory.ts.fixture', '51ec19aa474ba3f755476487cc5346ddf51266155a3657a4b87b5c4bd1f83fe0'], identity],
    gold: [['src/memory.ts', 'gold-memory.ts.fixture', '7f1a42038c8d9de7a9af3d6237dc471844baaac99f00cb2d8aff672345f038e0'], identity],
  }, probeSha256: '233fc44d779bce44fc5f8c385d5782a8ff6883561dfae771ef2f2ab12ff2633a',
};
