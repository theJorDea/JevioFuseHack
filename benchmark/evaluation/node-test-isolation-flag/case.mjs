export default {
  "id": "node-test-isolation-flag",
  "task": "Allow the project test suite to run with isolation disabled across supported Node versions without dropping its test file arguments.",
  "files": {
    "base": [
      [
        "package.json",
        "base-package.json.fixture",
        "06f9c5f2396b202a16c1a7f9d93b263025569dcfa75a70c1d91043dd64954146"
      ]
    ],
    "gold": [
      [
        "package.json",
        "gold-package.json.fixture",
        "89c2cf0cf3c046a883a7d64beb67bf748a0535129d133cd71a474a2e2f5b8ed6"
      ],
      [
        "scripts/run-tests.mjs",
        "gold-run-tests.mjs.fixture",
        "e191fc09436ba1945a0ac21f41f9cd9d12b251fd957b65ad4e76852a9828f1fb"
      ]
    ]
  },
  "probeSha256": "550b3726c693e9f75d35667a350845a10fba5a1a7625044b74c27bfb4c93d311"
};
