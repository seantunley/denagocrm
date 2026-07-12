import crypto from "crypto";
import { Prisma } from "@prisma/client";
import { basePrisma } from "./db";

export const PORTABLE_BACKUP_FORMAT = "denagocrm-portable-backup";
export const PORTABLE_BACKUP_VERSION = 2;

export type AssetBackupEntry = {
  sourceRef: string;
  sourceType: string;
  sha256: string;
  sizeBytes: number;
  backupPath: string;
};

export type PortableBackup = {
  metadata