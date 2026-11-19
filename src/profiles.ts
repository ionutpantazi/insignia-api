import { Ajv } from "ajv";
import sharp from "sharp";
import schemaV3 from "./schemas/settings-profile.v3.json" with { type: "json" };
import schemaV4 from "./schemas/settings-profile.v4.json" with { type: "json" };
import schemaV5 from "./schemas/settings-profile.v5.json" with { type: "json" };
import { type Position } from "./backup.js";
import { HttpError } from "./errors.js";

type Image = { mediaType: "image/png" | "image/jpeg"; dataBase64: string };
type SectionSize = { width: number; height: number } | null;

export interface ProfileWriteV3 {
  schemaVersion: 3;
  name: string;
  settings: {
    clock: { style: "digital" | "analog"; sizePercent: number };
    positions: Record<"clock" | "shortcuts" | "actions" | "music", Position>;
    showShortcuts: boolean;
    hideStatusBar: boolean;
    useSteeringWheelButtons: boolean;
    musicMode: "none" | "local" | "spotify" | "radio";
    radio: { serverUrl: string | null; autoplay: boolean; width: number; height: number };
    spotify: {
      clientId: string | null;
      playbackUri: string | null;
      autoConnect: boolean;
      width: number;
      height: number;
      maxTitleLines: number;
    };
    background: { type: "dark" } | { type: "custom"; image: Image };
  };
}

export interface ProfileWriteV4 {
  schemaVersion: 4;
  name: string;
  settings: ProfileWriteV3["settings"] & {
    sectionSizes: Record<"clock" | "shortcuts" | "music", SectionSize>;
  };
}

export interface ProfileWriteV5 {
  schemaVersion: 5;
  name: string;
  settings: Omit<ProfileWriteV4["settings"], "positions" | "sectionSizes"> & {
    positions: Omit<ProfileWriteV4["settings"]["positions"], "music">;
    sectionSizes: Omit<ProfileWriteV4["settings"]["sectionSizes"], "music">;
    musicLayouts: Record<"local" | "radio" | "spotify", { position: Position; size: SectionSize }>;
  };
}

export type ProfileWrite = ProfileWriteV3 | ProfileWriteV4 | ProfileWriteV5;
export type ProfileVersion = ProfileWrite["schemaVersion"];

export interface ProfileSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export const profilePageSize = 50;

export interface ProfileStore {
  list(uid: string, after: string, version: ProfileVersion): Promise<ProfileSummary[]>;
  get(uid: string, id: string, version: ProfileVersion): Promise<{ payload: unknown; updatedAt: string } | null>;
  create(uid: string, id: string, profile: ProfileWrite, updatedAt: Date): Promise<void>;
  overwrite(uid: string, id: string, profile: ProfileWrite, updatedAt: Date): Promise<boolean>;
}

const ajv = new Ajv({ allErrors: true, strict: true, ownProperties: true });
export const profileValidators = {
  3: ajv.compile<ProfileWriteV3>(schemaV3),
  4: ajv.compile<ProfileWriteV4>(schemaV4),
  5: ajv.compile<ProfileWriteV5>(schemaV5),
};

export function isPublicRadioUrl(value: string): boolean {
  if (/[\s\\\x00-\x1f\x7f#]/.test(value)) return false;
  const authority = /^https?:\/\/([^/?]+)/.exec(value)?.[1];
  if (!authority || authority.includes("@")) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  if (url.username || url.password) return false;
  for (const key of url.searchParams.keys()) {
    const compact = key.toLowerCase().replace(/[\s._-]/g, "");
    if (/(?:password|passwd|passphrase|secret|token|apikey|credential|signature|authorization|accesskey|privatekey|session|bearer|oauth)/.test(compact)
      || /^(?:auth|key|sig|pwd|user|username|login|code|jwt|hmac)$/.test(compact)) {
      return false;
    }
  }
  return true;
}

const maxImageBytes = 2 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function prepareProfile<T extends ProfileWrite>(profile: T): Promise<T> {
  const background = profile.settings.background;
  if (background.type === "dark") return profile;
  const { mediaType, dataBase64 } = background.image;
  const input = Buffer.from(dataBase64, "base64");
  if (input.length === 0 || input.length > maxImageBytes || input.toString("base64") !== dataBase64) {
    throw new HttpError(422, "INVALID_WALLPAPER", "Wallpaper must be canonical base64 encoding at most 2 MiB.");
  }
  const isPng = mediaType === "image/png";
  if (isPng ? !input.subarray(0, 8).equals(pngSignature) : input[0] !== 0xff || input[1] !== 0xd8) {
    throw new HttpError(422, "INVALID_WALLPAPER", "Wallpaper bytes do not match the declared PNG or JPEG type.");
  }

  let output: Buffer;
  try {
    const image = sharp(input, { limitInputPixels: 8_000_000, failOn: "warning" }).autoOrient();
    output = await (isPng ? image.png() : image.jpeg({ quality: 85 })).toBuffer();
  } catch (error) {
    throw new HttpError(422, "INVALID_WALLPAPER", "Wallpaper must be a readable PNG or JPEG of at most 8 million pixels.", { cause: error });
  }
  if (output.length > maxImageBytes) {
    throw new HttpError(422, "INVALID_WALLPAPER", "Wallpaper exceeds 2 MiB after processing; resize it and try again.");
  }
  return {
    ...profile,
    settings: {
      ...profile.settings,
      background: { type: "custom", image: { mediaType, dataBase64: output.toString("base64") } },
    },
  };
}
