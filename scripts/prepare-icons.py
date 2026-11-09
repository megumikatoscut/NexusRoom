"""Generate the application icon resources from PIC without changing the artwork."""
from pathlib import Path
import hashlib
import json
import shutil
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "android/app/src/main/res"


def resized(image, size):
    return image.resize((size, size), Image.Resampling.LANCZOS)


def main():
    pc = Image.open(ROOT / "PIC/PC.png").convert("RGBA")
    phone = Image.open(ROOT / "PIC/APK.png").convert("RGBA")
    for name, image in [("PC", pc), ("APK", phone)]:
        if image.width != image.height:
            raise ValueError(f"PIC/{name}.png must have a square canvas")
    pc.save(ROOT / "PIC/PC.ico", format="ICO", bitmap_format="bmp",
            sizes=[(n, n) for n in (16, 20, 24, 32, 40, 48, 64, 128, 256)])
    favicon = ROOT / "src/NexusRoom.Web/public/favicon.ico"
    shutil.copyfile(ROOT / "PIC/PC.ico", favicon)
    for density, scale in [("mdpi", 1), ("hdpi", 1.5), ("xhdpi", 2),
                           ("xxhdpi", 3), ("xxxhdpi", 4)]:
        directory = RES / f"mipmap-{density}"
        directory.mkdir(parents=True, exist_ok=True)
        resized(phone, round(48 * scale)).save(directory / "ic_launcher.png")
        foreground = Image.new("RGBA", (round(108 * scale),) * 2)
        content = resized(phone, round(72 * scale))
        offset = (foreground.width - content.width) // 2
        foreground.alpha_composite(content, (offset, offset))
        foreground.save(directory / "ic_launcher_foreground.png")
    files = [ROOT / "PIC/PC.png", ROOT / "PIC/APK.png", Path(__file__).resolve(),
             ROOT / "PIC/PC.ico", favicon] + sorted(RES.glob("mipmap-*/ic_launcher*.png"))
    manifest = {"schemaVersion": 1, "files": [
        {"path": path.relative_to(ROOT).as_posix(),
         "sha256": hashlib.sha256(path.read_bytes()).hexdigest()} for path in files]}
    (ROOT / "PIC/ICON_MANIFEST.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Application icons generated from PIC/PC.png and PIC/APK.png.")


if __name__ == "__main__":
    main()
