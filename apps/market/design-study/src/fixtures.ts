// All names, shops, availability, and prices are fictional design fixtures.
// These are NOT Nostr product events. No keys, signatures, or live data needed.
export type Artwork = "shirt" | "coffee" | "bag" | "mug" | "print" | "notebook"
export type Category = "Clothing" | "Food & drink" | "Home" | "Art & stationery"

export type StudyProduct = {
  id: string
  title: string
  store: string
  category: Category
  sats: number
  artwork?: Artwork
  // Optional local asset import, e.g. import totePhoto from "./assets/tote.jpg".
  image?: string
  soldOut?: boolean
  options?: string[]
}

export const products: StudyProduct[] = [
  {
    id: "tee",
    title: "Everyday cotton tee",
    store: "Common Thread",
    category: "Clothing",
    sats: 32000,
    artwork: "shirt",
    options: ["Small", "Medium", "Large"],
  },
  {
    id: "coffee",
    title: "Market morning blend",
    store: "Early Bird",
    category: "Food & drink",
    sats: 18000,
    artwork: "coffee",
    options: ["Whole bean", "Ground"],
  },
  {
    id: "tote",
    title: "Carry-all canvas tote",
    store: "Common Thread",
    category: "Home",
    sats: 24000,
    artwork: "bag",
  },
  {
    id: "mug",
    title: "Hand-thrown everyday mug",
    store: "Soft Earth",
    category: "Home",
    sats: 28000,
    artwork: "mug",
  },
  {
    id: "print",
    title:
      "After the market — limited edition screen print on heavyweight recycled paper",
    store: "Paper & Ink",
    category: "Art & stationery",
    sats: 45000,
    artwork: "print",
  },
  {
    id: "notebook",
    title: "Pocket notebook, set of three",
    store: "Paper & Ink",
    category: "Art & stationery",
    sats: 12000,
    artwork: "notebook",
  },
  {
    id: "shirt",
    title: "Weekend long-sleeve",
    store: "Common Thread",
    category: "Clothing",
    sats: 48000,
    artwork: "shirt",
    soldOut: true,
  },
  {
    id: "tea",
    title: "Evening loose-leaf tea",
    store: "Early Bird",
    category: "Food & drink",
    sats: 14000,
    artwork: "coffee",
  },
  {
    id: "bowl",
    title: "Small ceramic bowl",
    store: "Soft Earth",
    category: "Home",
    sats: 22000,
  },
  {
    id: "bag",
    title: "Utility shoulder bag",
    store: "Common Thread",
    category: "Clothing",
    sats: 56000,
    artwork: "bag",
  },
  {
    id: "journal",
    title: "Open space journal",
    store: "Paper & Ink",
    category: "Art & stationery",
    sats: 20000,
    artwork: "notebook",
  },
  {
    id: "cup",
    title: "Espresso cup pair",
    store: "Soft Earth",
    category: "Home",
    sats: 36000,
    artwork: "mug",
  },
]

export const categories: Category[] = [
  "Clothing",
  "Food & drink",
  "Home",
  "Art & stationery",
]
export const stores = [...new Set(products.map((product) => product.store))]
export const formatSats = (value: number) =>
  `${value.toLocaleString("en-US")} sats`
