"""Renders the interface's lime dot mark into the Windows app icon."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent.parent
image = Image.new('RGBA', (512, 512), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((8, 8, 504, 504), radius=108, fill='#161817')
draw.ellipse((128, 128, 384, 384), fill='#c9d940')
image.save(root / 'assets/icon.png')
image.save(root / 'assets/icon.ico', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('Created assets/icon.png and assets/icon.ico')
