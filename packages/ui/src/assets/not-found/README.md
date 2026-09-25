# 404 background media

- Source: [Stunning Spiral Galaxy with Twinkling Stars](https://www.pexels.com/video/stunning-spiral-galaxy-with-twinkling-stars-33506229/) by Nicola Narracci.
- License: [Pexels License](https://www.pexels.com/license/), checked September 25, 2026. Free website use and modification are permitted.
- Original: https://videos.pexels.com/video-files/33506229/14251140_1920_1080_30fps.mp4
- Adaptation: first six seconds, followed by their reverse for a continuous 12-second loop. Resized to 1280 × 720, 24 fps, H.264, CRF 28, without audio, with fast-start metadata.
- Poster: first frame, 1280 × 720 JPEG.
- The Bitcoin symbol is a separate Lucide icon, not part of the licensed footage.

Serve these assets locally. Do not replace them with third-party embeds or tracking URLs.

The 812 KiB clip is fetched once per mount and played from a browser object URL. [Cloudflare Pages returns 200 for range requests](https://developers.cloudflare.com/pages/configuration/serving-pages/#behavior), which breaks WebKit seeking and looping with a direct media URL. Abort the fetch and revoke the object URL on unmount or when reduced motion is enabled. Keep replacement clips small; this approach buffers the entire clip before playback.
