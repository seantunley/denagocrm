import { crc32 } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer; modified?: Date };

/** MS-DOS date and time, the only timestamp a plain ZIP entry carries. UTC, so the same input always gives the same archive. */
function dosStamp(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

/**
 * A ZIP archive with every file STORED, not compressed.
 *
 * For handing someone a handful of files as one download. The files this is used
 * for are a sealed PDF (already compressed) and a few kilobytes of text, so
 * compressing would buy nothing, and storing keeps each file byte-for-byte what
 * it was — which matters when one of them is a document whose hash is evidence.
 *
 * ponytail: stored only and no ZIP64, so each file and the whole archive must
 * stay under 4 GB and there can be at most 65,535 files. Reach for a library
 * when something bigger than an evidence pack needs zipping.
 */
export function zipStore(entries: ZipEntry[]): Buffer {
  const files: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const { time, date } = dosStamp(entry.modified ?? new Date());
    const checksum = crc32(entry.data);
    const size = entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(size, 18); // compressed
    local.writeUInt32LE(size, 22); // uncompressed
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // central directory header
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42); // where this file's local header starts
    directory.push(central, name);

    offset += local.length + name.length + size;
  }

  const index = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}
