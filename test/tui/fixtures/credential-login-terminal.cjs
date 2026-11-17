const path = require("node:path");
const { loadCredentialRuntime } = require("../../fixtures/credential-runtime.cjs");
const { withCredentialLogin } = require("../../../vendor/cli-config.cjs");

const { createSystemCredentialCipher } = loadCredentialRuntime({
  platform: "linux",
  entry: { getSecret: async () => { throw new Error("Secret Service unavailable"); } }
});
const cipher = createSystemCredentialCipher({ filePath: path.join(process.env.HOME, ".zcode", "v2", "credentials.json"), env: {} });
withCredentialLogin({}, () => cipher.encrypt("fixture-login-token")).then(
  () => console.log("LOGIN_CONTINUED"),
  () => console.log("LOGIN_CANCELLED")
);
