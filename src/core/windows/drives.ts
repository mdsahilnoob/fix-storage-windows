import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { Drive, Mount, Partition } from "../drives";
import { powerShellJson } from "./powershell";
import { atOrInside, normalPath } from "./paths";

interface WindowsVolume {
  id: string;
  name: string;
  letter: string;
  label: string;
  fileSystem: string;
  capacity: number;
  freeSpace: number;
  driveType: number;
  access: number;
  boot: boolean;
  system: boolean;
  mountPoints: string[];
}

const TYPE: Record<number, string> = {
  0: "unknown",
  1: "no root directory",
  2: "removable",
  3: "fixed",
  4: "network",
  5: "optical",
  6: "ram disk",
};

// Win32_Volume includes NTFS mount points and volumes without a drive letter.
// No user path is interpolated into this fixed query.
const QUERY = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
$links = @(Get-CimInstance Win32_MountPoint)
$volumes = Get-CimInstance Win32_Volume | ForEach-Object {
  $volume = $_
  $mountedFolders = @($links | Where-Object { $_.Volume.DeviceID -eq $volume.DeviceID } | ForEach-Object { $_.Directory.Name })
  $points = @($volume.Name) + $mountedFolders
  if ($volume.DriveLetter) { $points = @("$($volume.DriveLetter)\\") + $points }
  [pscustomobject]@{
    id = [string]$volume.DeviceID
    name = [string]$volume.Name
    letter = [string]$volume.DriveLetter
    label = [string]$volume.Label
    fileSystem = [string]$volume.FileSystem
    capacity = [double]$volume.Capacity
    freeSpace = [double]$volume.FreeSpace
    driveType = [int]$volume.DriveType
    access = [int]$volume.Access
    boot = [bool]$volume.BootVolume
    system = [bool]$volume.SystemVolume
    mountPoints = @($points | Where-Object { $_ } | Select-Object -Unique)
  }
}
ConvertTo-Json -Compress -Depth 4 @($volumes)
`;

function usablePoint(point: string): boolean {
  return /^[a-z]:\\/i.test(point);
}

function displayName(volume: WindowsVolume, mount: string): string {
  const letter = volume.letter ? `${volume.letter}` : mount.replace(/\\$/, "");
  return volume.label ? `${letter} ${volume.label}` : letter;
}

function asDrive(volume: WindowsVolume, home: string): Drive | null {
  const points = volume.mountPoints.filter(usablePoint).map((point) => resolve(point));
  if (points.length === 0) return null;
  const homePoint = points.find((point) => atOrInside(home, point));
  const mount = homePoint ?? points.find((point) => /^[a-z]:\\$/i.test(point)) ?? points[0];
  const system = volume.boot || volume.system || atOrInside(process.env.SystemRoot ?? "C:\\Windows", mount);
  const mounts: Mount[] = points.map((point) => ({
    id: volume.id,
    root: "\\",
    point,
    fstype: volume.fileSystem || "unknown",
    source: volume.id,
    readOnly: volume.access === 1,
  }));
  return {
    id: volume.id || normalPath(mount),
    name: displayName(volume, mount),
    mount,
    mounts,
    device: volume.id,
    fstype: volume.fileSystem || "unknown",
    label: volume.label,
    readOnly: volume.access === 1,
    kind: volume.system && !volume.boot ? "boot" : system ? "main" : "data",
    home: atOrInside(home, mount),
    system,
    driveType: TYPE[volume.driveType] ?? "unknown",
    capacity: volume.capacity || 0,
    freeSpace: volume.freeSpace || 0,
  };
}

export async function listWindowsDrives(home = homedir()): Promise<{ drives: Drive[]; unmounted: Partition[] }> {
  const response = await powerShellJson<WindowsVolume[] | WindowsVolume>(QUERY);
  const volumes = Array.isArray(response) ? response : [response];
  const drives = volumes.map((volume) => asDrive(volume, home)).filter((drive): drive is Drive => !!drive);
  drives.sort((a, b) => Number(b.home) - Number(a.home) || Number(b.system) - Number(a.system) || a.mount.localeCompare(b.mount));

  const unmounted: Partition[] = [];
  for (const volume of volumes) {
    if (volume.mountPoints.some(usablePoint) || !volume.fileSystem || volume.boot || volume.system) continue;
    unmounted.push({
      device: volume.id || volume.name,
      fstype: volume.fileSystem,
      label: volume.label,
      size: volume.capacity || 0,
      type: TYPE[volume.driveType] ?? "volume",
    });
  }
  return { drives, unmounted };
}

export function pickWindowsDrive(wanted: string | undefined, drives: Drive[]): Drive | undefined {
  if (!wanted) return drives[0];
  if (/^[a-z]:$/i.test(wanted)) wanted += "\\";
  const named = drives.find(
    (drive) =>
      [drive.name, drive.label, drive.mount, drive.device].some((value) => value.toLowerCase() === wanted.toLowerCase()) ||
      drive.mounts.some((mount) => mount.point.toLowerCase() === wanted.toLowerCase()),
  );
  if (named) return named;
  if (/^\d+$/.test(wanted)) return drives[Number(wanted) - 1];
  if (!isAbsolute(wanted)) return undefined;
  const target = normalPath(resolve(wanted));
  return drives
    .filter((drive) => drive.mounts.some((mount) => target === normalPath(mount.point) || target.startsWith(normalPath(mount.point) + "\\")))
    .sort((a, b) => b.mount.length - a.mount.length)[0];
}

export function windowsMountAdvice(): string {
  return "Assign a drive letter or mount point in Windows Disk Management to browse this volume.";
}

