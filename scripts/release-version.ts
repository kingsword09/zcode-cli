const appVersionPattern = /^\d+\.\d+\.\d+$/u;
const releaseVersionPattern = /^(\d+\.\d+\.\d+)-([1-9]\d*)$/u;

export interface ReleaseVersion {
  appVersion: string;
  build: number;
}

export function parseReleaseVersion(version: string): ReleaseVersion | undefined {
  const match = releaseVersionPattern.exec(version.trim());
  if (!match) return undefined;
  return {
    appVersion: match[1]!,
    build: Number(match[2])
  };
}

export function syncedReleaseVersion(appVersion: string, currentVersion: string): string {
  const normalizedAppVersion = appVersion.trim();
  if (!appVersionPattern.test(normalizedAppVersion)) {
    throw new Error(`Unsupported ZCode App version: ${appVersion}`);
  }
  const build = parseReleaseVersion(currentVersion)?.build ?? 1;
  return `${normalizedAppVersion}-${build}`;
}

export function nextBuildVersion(currentVersion: string): string {
  const current = parseReleaseVersion(currentVersion);
  if (!current) {
    throw new Error(`Expected an <app-version>-<build> version, found: ${currentVersion}`);
  }
  return `${current.appVersion}-${current.build + 1}`;
}

export function compareReleaseVersions(left: string, right: string): number {
  const leftVersion = parseReleaseVersion(left);
  const rightVersion = parseReleaseVersion(right);
  if (!leftVersion || !rightVersion) {
    throw new Error(`Cannot compare release versions: ${left} and ${right}`);
  }
  const leftParts = [...leftVersion.appVersion.split(".").map(Number), leftVersion.build];
  const rightParts = [...rightVersion.appVersion.split(".").map(Number), rightVersion.build];
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}
