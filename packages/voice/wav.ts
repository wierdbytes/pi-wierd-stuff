/**
 * Minimal WAV writer for 24 kHz / 16-bit / mono PCM (the format
 * `gemini-3.1-flash-tts-preview` returns: `audio/L16;codec=pcm;rate=24000`).
 *
 * Writes a 44-byte canonical RIFF/fmt/data header, then the PCM payload.
 * The official @google/genai sample uses the `wav` npm package; for our
 * one-shot writer it's overkill — this is ~40 lines of Buffer math, no
 * extra dependency.
 *
 * Header layout (PCM, mono, 16-bit, little-endian):
 *
 *  Offset  Size  Field           Value
 *  ------  ----  --------------  ------------------------------------
 *   0       4    ChunkID         "RIFF"
 *   4       4    ChunkSize       36 + dataLen   (file size − 8)
 *   8       4    Format          "WAVE"
 *  12       4    Subchunk1ID     "fmt "
 *  16       4    Subchunk1Size   16             (PCM)
 *  20       2    AudioFormat      1             (PCM = uncompressed)
 *  22       2    NumChannels      1
 *  24       4    SampleRate       24000
 *  28       4    ByteRate         48000         (rate * channels * bps/8)
 *  32       2    BlockAlign       2             (channels * bps/8)
 *  34       2    BitsPerSample   16
 *  36       4    Subchunk2ID     "data"
 *  40       4    Subchunk2Size   dataLen
 *  44       …    PCM data        <pcm bytes>
 */

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export const GEMINI_TTS_FORMAT: WavFormat = {
  sampleRate: 24_000,
  channels: 1,
  bitsPerSample: 16,
};

export const WAV_HEADER_BYTES = 44;

/**
 * Wrap raw PCM bytes in a canonical 44-byte WAV header. Returns a fresh
 * Buffer (header || pcm) — no mutation of the input.
 */
export function pcmToWav(pcm: Buffer, format: WavFormat = GEMINI_TTS_FORMAT): Buffer {
  const { sampleRate, channels, bitsPerSample } = format;
  const dataLen = pcm.length;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(WAV_HEADER_BYTES);
  let offset = 0;

  // RIFF chunk
  header.write("RIFF", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(36 + dataLen, offset);
  offset += 4;
  header.write("WAVE", offset, "ascii");
  offset += 4;

  // fmt subchunk
  header.write("fmt ", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(16, offset); // Subchunk1Size for PCM
  offset += 4;
  header.writeUInt16LE(1, offset); // AudioFormat = PCM
  offset += 2;
  header.writeUInt16LE(channels, offset);
  offset += 2;
  header.writeUInt32LE(sampleRate, offset);
  offset += 4;
  header.writeUInt32LE(byteRate, offset);
  offset += 4;
  header.writeUInt16LE(blockAlign, offset);
  offset += 2;
  header.writeUInt16LE(bitsPerSample, offset);
  offset += 2;

  // data subchunk
  header.write("data", offset, "ascii");
  offset += 4;
  header.writeUInt32LE(dataLen, offset);
  offset += 4;

  return Buffer.concat([header, pcm], header.length + dataLen);
}
