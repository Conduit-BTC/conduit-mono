import {
  Coffee,
  ImageOff,
  NotebookPen,
  PictureInPicture2,
  ShoppingBag,
  Shirt,
  CupSoda,
} from "lucide-react"
import type { StudyProduct } from "./fixtures"

const icons = {
  shirt: Shirt,
  coffee: Coffee,
  bag: ShoppingBag,
  mug: CupSoda,
  print: PictureInPicture2,
  notebook: NotebookPen,
}

export function ProductArtwork({ product }: { product: StudyProduct }) {
  if (product.image) {
    return (
      <img
        src={product.image}
        alt=""
        className="study-artwork object-cover"
        loading="lazy"
      />
    )
  }
  const Icon = product.artwork ? icons[product.artwork] : ImageOff
  return (
    <div className="study-artwork" data-artwork={product.artwork ?? "missing"}>
      <Icon
        className="size-16 sm:size-20"
        strokeWidth={1.25}
        aria-hidden="true"
      />
      <span className="text-xs">
        {product.artwork ? "Sample artwork" : "No image available"}
      </span>
    </div>
  )
}
