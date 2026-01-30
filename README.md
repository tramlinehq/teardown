# teardown

Browser-based mobile build inspector. Drag and drop an APK, AAB, or IPA and get build metadata — everything runs locally, nothing leaves your browser.

https://teardown.mobi

## What it parses

### Android APK
Decodes the compiled binary XML (AXML) format for `AndroidManifest.xml`, including string pools, resource ID maps, and 12+ typed attribute value kinds (dimensions, fractions, references, etc.)

### Android AAB
AAPT2 serializes the manifest as protobuf, not AXML. Includes a from-scratch protobuf wire format decoder that walks the AAPT2 schema field numbers to reconstruct the XML tree. Falls back to AXML if needed.

### iOS IPA
Parses Apple's binary plist format (`bplist00`) for `Info.plist`, and extracts provisioning profile data from the CMS-signed `embedded.mobileprovision` blob.

## Weird things it handles

### Crushed PNGs (CgBI)
Xcode "optimizes" PNGs into a proprietary format: zlib headers stripped, pixels reordered to BGRA, and RGB values premultiplied by alpha. The app reverses all of this (raw deflate → undo row filters → BGRA→RGBA → unpremultiply) to display iOS app icons.

### Protobuf without a schema library
AAB manifests are decoded using a hand-rolled protobuf parser that maps known AAPT2 field numbers to XML nodes. No `protoc`, no generated code.

### Binary XML
APK manifests aren't XML. They're a chunked binary format with interleaved string pools, namespace tables, and resource maps. Parsed from scratch.

## Dependencies

Just [JSZip](https://stuk.github.io/jszip/) (loaded from CDN). Everything else is vanilla JS.
