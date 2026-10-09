import { Buffer } from "node:buffer";

export function browserOpenCommand(platform: NodeJS.Platform, url: string): { executable: string; args: string[] } {
  if (platform === "darwin") return { executable: "open", args: [url] };
  if (platform !== "win32") return { executable: "xdg-open", args: [url] };

  // cmd.exe interprets OAuth query separators (&) and percent-encoded values
  // even when invoked through spawn(). Decode the URL as data inside PowerShell
  // so neither its quotes nor shell syntax become code. Encode the command as
  // well so Windows argument quoting cannot alter it.
  const encodedUrl = Buffer.from(url, "utf8").toString("base64");
  const command = `Start-Process -FilePath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedUrl}')))`;
  return {
    executable: "powershell.exe",
    args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")]
  };
}
