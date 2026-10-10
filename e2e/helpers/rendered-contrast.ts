import type { Locator } from "@playwright/test"

// Composite translucent ancestors before measuring the actual text surface.
export async function measureTextContrast(locator: Locator) {
  return locator.evaluateAll((elements) => {
    const components = (value: string) => {
      const n = value.match(/[\d.]+/g)!.map(Number)
      return value.startsWith("color(srgb")
        ? n.map((v, i) => (i < 3 ? v * 255 : v))
        : n
    }
    const rgb = (value: string) => components(value).slice(0, 3)
    const over = (fg: number[], bg: number[], alpha: number) =>
      fg.map((v, i) => v * alpha + bg[i] * (1 - alpha))
    const luminance = (c: number[]) =>
      c
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0)
    const background = (el: Element): number[] => {
      const value = getComputedStyle(el).backgroundColor
      const numbers = components(value)
      const alpha = numbers[3] ?? 1
      return alpha === 1
        ? numbers.slice(0, 3)
        : over(
            numbers.slice(0, 3),
            el.parentElement ? background(el.parentElement) : [255, 255, 255],
            alpha
          )
    }
    return elements.map((el) => {
      const color = rgb(getComputedStyle(el).color),
        bg = background(el)
      const a = luminance(color),
        b = luminance(bg)
      return {
        id: el.getAttribute("data-testid") ?? "bitcoin-price",
        color,
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
      }
    })
  })
}
