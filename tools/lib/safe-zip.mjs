import { inflateRawSync } from 'node:zlib';

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRY_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 16;

export function extractBoundedZipFiles(input) {
  const archive = Buffer.from(input);
  if (archive.length === 0 || archive.length > MAX_ARCHIVE_BYTES) throw new Error('CI proof archive size is invalid.');
  const endOffset = findEndRecord(archive);
  const disk = archive.readUInt16LE(endOffset + 4);
  const centralDisk = archive.readUInt16LE(endOffset + 6);
  const diskEntries = archive.readUInt16LE(endOffset + 8);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const commentLength = archive.readUInt16LE(endOffset + 20);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount || entryCount === 0 || entryCount > MAX_ENTRIES
    || entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || endOffset + 22 + commentLength !== archive.length
    || centralOffset + centralSize !== endOffset) {
    throw new Error('CI proof archive directory is invalid or unsupported.');
  }

  const files = new Map();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('CI proof archive central directory is malformed.');
    }
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const entryCommentLength = archive.readUInt16LE(cursor + 32);
    const creatorSystem = archive.readUInt16LE(cursor + 4) >>> 8;
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const recordEnd = cursor + 46 + nameLength + extraLength + entryCommentLength;
    if ((flags & 0x1) !== 0 || ![0, 8].includes(method)
      || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff
      || compressedSize > MAX_ENTRY_BYTES || uncompressedSize > MAX_ENTRY_BYTES
      || recordEnd > endOffset) {
      throw new Error('CI proof archive entry is unsafe or unsupported.');
    }
    const name = decodeName(archive.subarray(cursor + 46, cursor + 46 + nameLength), flags);
    validateEntryName(name);
    const unixMode = externalAttributes >>> 16;
    const unixType = unixMode & 0o170000;
    const dosDirectory = (externalAttributes & 0x10) !== 0;
    if (name.endsWith('/') || dosDirectory || (creatorSystem === 3 && unixMode !== 0 && unixType !== 0o100000)) {
      throw new Error('CI proof archive entries must be regular files.');
    }
    if (files.has(name)) throw new Error('CI proof archive contains duplicate entries.');
    const content = readEntry(archive, { localOffset, expectedName: name, flags, method, compressedSize, uncompressedSize });
    if (crc32(content) !== crc) throw new Error('CI proof archive entry checksum is invalid.');
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error('CI proof archive expanded size exceeds its limit.');
    files.set(name, content);
    cursor = recordEnd;
  }
  if (cursor !== endOffset) throw new Error('CI proof archive central directory size is inconsistent.');
  return files;
}

function findEndRecord(archive) {
  const minimum = Math.max(0, archive.length - 22 - 0xffff);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  throw new Error('CI proof archive end record was not found.');
}

function decodeName(bytes, flags) {
  if ((flags & 0x800) === 0 && bytes.some((value) => value > 0x7f)) {
    throw new Error('CI proof archive entry names must be UTF-8 or ASCII.');
  }
  const name = bytes.toString('utf8');
  if (Buffer.from(name, 'utf8').compare(bytes) !== 0) throw new Error('CI proof archive entry name is invalid UTF-8.');
  return name;
}

function validateEntryName(name) {
  if (!name || name.length > 240 || name.includes('\0') || name.includes('\\') || name.startsWith('/')
    || /^[A-Za-z]:/u.test(name) || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('CI proof archive entry path is unsafe.');
  }
}

function readEntry(archive, entry) {
  const offset = entry.localOffset;
  if (offset + 30 > archive.length || archive.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new Error('CI proof archive local header is invalid.');
  }
  const flags = archive.readUInt16LE(offset + 6);
  const method = archive.readUInt16LE(offset + 8);
  const nameLength = archive.readUInt16LE(offset + 26);
  const extraLength = archive.readUInt16LE(offset + 28);
  const nameStart = offset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (flags !== entry.flags || method !== entry.method || dataEnd > archive.length
    || decodeName(archive.subarray(nameStart, nameStart + nameLength), flags) !== entry.expectedName) {
    throw new Error('CI proof archive local entry does not match its directory.');
  }
  const compressed = archive.subarray(dataStart, dataEnd);
  let content;
  try {
    content = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch {
    throw new Error('CI proof archive entry could not be decompressed safely.');
  }
  if (content.length !== entry.uncompressedSize) throw new Error('CI proof archive entry size is invalid.');
  return content;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
