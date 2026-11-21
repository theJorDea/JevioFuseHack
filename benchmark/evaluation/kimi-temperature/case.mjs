export default {
  id: 'kimi-temperature',
  task: 'Make chat requests compatible with the temperature requirement of Kimi models without changing how other models use temperature settings.',
  files: {
    base: [['src/provider/openai-compatible.ts', 'base-provider.ts.fixture', 'f6db42ae708beec15c6fed8092a1bb6679a1c853f383c2a7af74b8f5f8f7cdbe']],
    gold: [['src/provider/openai-compatible.ts', 'gold-provider.ts.fixture', '9bec8d649314413f5746f6a063e5fe7ff0315f5eaf05545a8b3386483de0ac7f']],
  },
  probeSha256: 'db3adb289ee78d57543151acebb810a0eb81b7aec767665ca2ce372eb4d55412',
};
