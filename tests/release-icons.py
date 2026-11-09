"""Check actual PE/APK icon resources against the artwork committed in PIC."""
import argparse
from collections import Counter
import hashlib
import io
import json
import mmap
import os
from pathlib import Path
import re
import struct
import subprocess
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def ico_images(path):
    data = path.read_bytes()
    reserved, kind, count = struct.unpack_from("<HHH", data)
    assert (reserved, kind, count) == (0, 1, 9), "Expected nine Windows icon sizes"
    result = []
    for index in range(count):
        length, offset = struct.unpack_from("<II", data, 6 + index * 16 + 8)
        result.append(data[offset:offset + length])
    return Counter(result)


def pe_icons(path):
    with path.open("rb") as stream, mmap.mmap(stream.fileno(), 0, access=mmap.ACCESS_READ) as data:
        assert data[:2] == b"MZ"
        pe = struct.unpack_from("<I", data, 0x3C)[0]
        assert data[pe:pe + 4] == b"PE\0\0"
        sections, optional_size = struct.unpack_from("<H12xH", data, pe + 6)
        optional = pe + 24
        magic = struct.unpack_from("<H", data, optional)[0]
        directories = optional + (112 if magic == 0x20B else 96)
        resource_rva, resource_size = struct.unpack_from("<II", data, directories + 16)
        table = optional + optional_size
        def offset(rva):
            for index in range(sections):
                virtual_size, virtual_address, raw_size, raw = struct.unpack_from(
                    "<IIII", data, table + index * 40 + 8)
                if virtual_address <= rva < virtual_address + max(virtual_size, raw_size):
                    return raw + rva - virtual_address
            raise AssertionError("Resource RVA outside PE sections")
        base = offset(resource_rva)
        def entries(relative):
            directory = base + relative
            named, numbered = struct.unpack_from("<HH", data, directory + 12)
            return [struct.unpack_from("<II", data, directory + 16 + i * 8)
                    for i in range(named + numbered)]
        icons = []
        def descend(relative):
            assert relative < resource_size
            for _, child in entries(relative):
                if child & 0x80000000:
                    descend(child & 0x7FFFFFFF)
                else:
                    rva, size = struct.unpack_from("<II", data, base + child)
                    start = offset(rva)
                    icons.append(data[start:start + size])
        for kind, child in entries(0):
            if kind == 3:
                assert child & 0x80000000
                descend(child & 0x7FFFFFFF)
        return Counter(icons)


def pixels_equal(left, right):
    left, right = left.convert("RGBA"), right.convert("RGBA")
    assert left.size == right.size, "Icon size mismatch"
    # Android PNG compilation can discard RGB under alpha zero. Compare alpha
    # and every visible RGB value without treating invisible bytes as artwork.
    def normalized(image):
        pixels = bytearray(image.tobytes())
        for index in range(0, len(pixels), 4):
            if pixels[index + 3] == 0:
                pixels[index:index + 3] = b"\0\0\0"
        return pixels
    assert normalized(left) == normalized(right), "Icon pixel mismatch"


def main():
    version = json.loads((ROOT / "release.json").read_text(encoding="utf-8"))["version"]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--exe", type=Path, default=(ROOT.parent / "02_Release_Artifacts/Windows" / f"NexusRoom-Windows-x64-{version}.exe" if (ROOT.parent / "02_Release_Artifacts").is_dir() else ROOT / f"artifacts/NexusRoom-Windows-x64-{version}.exe"))
    parser.add_argument("--host", type=Path, required=True, help="Path to the published NexusRoom.Host.exe")
    parser.add_argument("--apk", type=Path, default=(ROOT.parent / "02_Release_Artifacts/Android" / f"NexusRoom-Android-{version}.apk" if (ROOT.parent / "02_Release_Artifacts").is_dir() else ROOT / f"artifacts/NexusRoom-Android-{version}.apk"))
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    parser.add_argument("--aapt", type=Path, default=Path(sdk) / "build-tools/35.0.0/aapt.exe" if sdk else None)
    args = parser.parse_args()
    manifest = json.loads((ROOT / "PIC/ICON_MANIFEST.json").read_text(encoding="utf-8"))
    for item in manifest["files"]:
        assert hashlib.sha256((ROOT / item["path"]).read_bytes()).hexdigest() == item["sha256"]
    expected = ico_images(ROOT / "PIC/PC.ico")
    for executable in [args.exe, args.host]:
        assert pe_icons(executable) == expected, "PE resources differ from PIC/PC.ico"
    phone = Image.open(ROOT / "PIC/APK.png").convert("RGBA")
    assert args.aapt and args.aapt.is_file(), "Specify --aapt or ANDROID_HOME for compiled resource lookup"
    def dump(*arguments):
        return subprocess.check_output([str(args.aapt), "dump", *arguments, str(args.apk)], encoding="utf-8")
    resources = dump("--values", "resources")
    locations, ids = {}, {}
    config = None
    pending = None
    for line in resources.splitlines():
        match = re.search(r"config ([^:]+):", line)
        if match:
            config, pending = match[1], None
        match = re.search(r"(?<!spec )resource (0x[0-9a-f]+) com\.nexusroom\.android:mipmap/(ic_launcher\w*):", line)
        if match:
            ids[match[2]] = match[1]
            pending = match[2]
        match = re.search(r'\(string8?\) "([^"]+)"', line)
        if match and pending:
            locations[config, pending] = match[1]
            pending = None
    with zipfile.ZipFile(args.apk) as apk:
        for density, scale in [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2), ("xxhdpi", 3), ("xxxhdpi", 4)]:
            for name in ["ic_launcher", "ic_launcher_foreground"]:
                compiled = Image.open(io.BytesIO(apk.read(locations[density, name])))
                source = Image.open(ROOT / f"android/app/src/main/res/mipmap-{density}/{name}.png")
                pixels_equal(compiled, source)
                if name == "ic_launcher":
                    pixels_equal(source, phone.resize((round(48 * scale),) * 2, Image.Resampling.LANCZOS))
        for name in ["ic_launcher", "ic_launcher_round"]:
            path = locations["anydpi", name]
            tree = subprocess.check_output([str(args.aapt), "dump", "xmltree", str(args.apk), path], encoding="utf-8")
            assert "E: adaptive-icon" in tree and "E: background" in tree and "E: foreground" in tree
            assert f"@{ids['ic_launcher_foreground']}" in tree
        manifest = subprocess.check_output([str(args.aapt), "dump", "xmltree", str(args.apk), "AndroidManifest.xml"], encoding="utf-8")
        assert re.search(r"android:icon\([^\n]+@" + ids["ic_launcher"] + r"\b", manifest)
        assert re.search(r"android:roundIcon\([^\n]+@" + ids["ic_launcher_round"] + r"\b", manifest)
    print("PASS packaged icons: both Windows PEs contain all nine PIC icons; APK preserves artwork and alpha across ten raster resources and two adaptive icons.")


if __name__ == "__main__":
    main()
