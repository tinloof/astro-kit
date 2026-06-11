export type Product = {
  id: number;
  emoji: string;
  name: string;
  blurb: string;
};

export const PRODUCTS: Product[] = [
  {
    id: 1,
    emoji: "🍐",
    name: "Royal Pears",
    blurb: "Hand-picked, absurdly juicy.",
  },
  { id: 2, emoji: "🧀", name: "Cheese Tower", blurb: "Five storeys of dairy." },
  {
    id: 3,
    emoji: "🍫",
    name: "Truffle Box",
    blurb: "Dark, milk, and mysterious.",
  },
  {
    id: 4,
    emoji: "🍷",
    name: "Cellar Red",
    blurb: "Pairs with everything above.",
  },
  { id: 5, emoji: "🥨", name: "Snack Crate", blurb: "Salty. Crunchy. Gone." },
  {
    id: 6,
    emoji: "🍯",
    name: "Wildflower Honey",
    blurb: "Bees did the hard part.",
  },
  {
    id: 7,
    emoji: "🫒",
    name: "Olive Sampler",
    blurb: "From groves with views.",
  },
  { id: 8, emoji: "🍪", name: "Cookie Tin", blurb: "Bakery-grade nostalgia." },
  {
    id: 9,
    emoji: "🍓",
    name: "Berry Basket",
    blurb: "Picked this morning, allegedly.",
  },
  {
    id: 10,
    emoji: "🥜",
    name: "Nut Medley",
    blurb: "Premium crunch portfolio.",
  },
  { id: 11, emoji: "🍊", name: "Citrus Crate", blurb: "Sunshine, boxed." },
  { id: 12, emoji: "☕", name: "Roast Trio", blurb: "Three origins, one mug." },
];
