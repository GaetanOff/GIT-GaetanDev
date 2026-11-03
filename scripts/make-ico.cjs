// Writes build/icon.ico (256, 48, 32 and 16 px, PNG-compressed) from build/icon.png,
// for Windows shortcuts. Run with: npx electron scripts/make-ico.cjs
const { app, nativeImage } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

app.whenReady().then(() => {
  const source = nativeImage.createFromPath(join(__dirname, '..', 'build', 'icon.png'))
  const images = [256, 48, 32, 16].map(size => ({ size, png: source.resize({ width: size, height: size, quality: 'best' }).toPNG() }))

  // ICO: a 6-byte header, a 16-byte entry per image, then the PNG data.
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16)
    e.writeUInt8(size >= 256 ? 0 : size, 0) // 0 means 256
    e.writeUInt8(size >= 256 ? 0 : size, 1)
    e.writeUInt16LE(1, 4) // colour planes
    e.writeUInt16LE(32, 6) // bits per pixel
    e.writeUInt32LE(png.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += png.length
    return e
  })
  writeFileSync(join(__dirname, '..', 'build', 'icon.ico'), Buffer.concat([header, ...entries, ...images.map(i => i.png)]))
  app.quit()
})
