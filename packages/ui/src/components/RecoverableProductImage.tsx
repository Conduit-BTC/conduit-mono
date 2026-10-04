import { useState, type ImgHTMLAttributes, type SyntheticEvent } from "react"
import { getProductImageSources, type ProductImage } from "@conduit/core"

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  image?: ProductImage
}

export function RecoverableProductImage({ image, ...props }: Props) {
  const sources = getProductImageSources(image)
  return (
    <ImageSources key={JSON.stringify(sources)} sources={sources} {...props} />
  )
}

function ImageSources({
  sources,
  onError,
  ...props
}: Omit<Props, "image"> & { sources: string[] }) {
  const [sourceIndex, setSourceIndex] = useState(0)
  function handleError(event: SyntheticEvent<HTMLImageElement>): void {
    if (sourceIndex + 1 < sources.length) setSourceIndex(sourceIndex + 1)
    else onError?.(event)
  }
  // No empty src: avoid a browser request to the current document.
  return <img {...props} src={sources[sourceIndex]} onError={handleError} />
}
