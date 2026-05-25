/**
 * Seed admin master-catalog products (hub stock + variants + category mapping).
 *
 * Prerequisite: run category seed first
 *   npm run seed:categories
 *
 * Usage (from backend/):
 *   npm run seed:products
 *   npm run seed:products:clear   # remove prior seed products + hub rows, then re-seed
 *
 * Requires MONGO_URI in backend/.env
 */

import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

import Category from "../app/models/category.js";
import Product from "../app/models/product.js";
import HubInventory from "../app/models/hubInventory.js";
import { ensureUniqueSlug } from "../app/utils/productSlug.js";
import {
  normalizeVariants,
  syncRootFromFirstVariant,
  totalVariantStock,
} from "../app/utils/productHelpers.js";

const DEFAULT_HUB_ID = process.env.DEFAULT_HUB_ID || "MAIN_HUB";
const SEED_TAG = "seed:catalog";

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function subSlug(parentName, subName) {
  return `${slugify(parentName)}-${slugify(subName)}`;
}

/** Stable food/grocery placeholder images (saved as URLs on the product). */
const PRODUCT_IMAGES = {
  milk: "https://images.unsplash.com/photo-1550583724-b2692b85b5f0?auto=format&fit=crop&w=600&q=80",
  butter: "https://images.unsplash.com/photo-1589985270623-96993e6fa2d7?auto=format&fit=crop&w=600&q=80",
  paneer: "https://images.unsplash.com/photo-1631452180519-c014fe946bc7?auto=format&fit=crop&w=600&q=80",
  tomato: "https://images.unsplash.com/photo-1546094096-0df4bcaaa337?auto=format&fit=crop&w=600&q=80",
  onion: "https://images.unsplash.com/photo-1518977956812-cd3dbadaef31?auto=format&fit=crop&w=600&q=80",
  rice: "https://images.unsplash.com/photo-1586201375767-2b74b2f508b9?auto=format&fit=crop&w=600&q=80",
  dal: "https://images.unsplash.com/photo-1584270354949-c26b0d3960b2?auto=format&fit=crop&w=600&q=80",
  oil: "https://images.unsplash.com/photo-1474979266404-7eaacbcd87c5?auto=format&fit=crop&w=600&q=80",
  masala: "https://images.unsplash.com/photo-1596040033229-a9821ebd058d?auto=format&fit=crop&w=600&q=80",
  chicken: "https://images.unsplash.com/photo-1604503468506-440d43c0c9c1?auto=format&fit=crop&w=600&q=80",
  eggs: "https://images.unsplash.com/photo-1582722872445-44dc5f7e3c8f?auto=format&fit=crop&w=600&q=80",
  cola: "https://images.unsplash.com/photo-1629203851122-3726ecdf080e?auto=format&fit=crop&w=600&q=80",
  biscuit: "https://images.unsplash.com/photo-1558961363-fa8a2d0dc638?auto=format&fit=crop&w=600&q=80",
  cleaner: "https://images.unsplash.com/photo-1585421514288-efb74c4b3776?auto=format&fit=crop&w=600&q=80",
  atta: "https://images.unsplash.com/photo-1574323347407-f5e1ad6d020b?auto=format&fit=crop&w=600&q=80",
  almonds: "https://images.unsplash.com/photo-1509440159596-0249088772ff?auto=format&fit=crop&w=600&q=80",
  frozen: "https://images.unsplash.com/photo-1574485007669-0c076e33ef2a?auto=format&fit=crop&w=600&q=80",
  noodles: "https://images.unsplash.com/photo-1569718212165-3a8278d5f624?auto=format&fit=crop&w=600&q=80",
  herbs: "https://images.unsplash.com/photo-1466692476866-aef1dfb1e735?auto=format&fit=crop&w=600&q=80",
  detergent: "https://images.unsplash.com/photo-1583947215259-38e31be8331c?auto=format&fit=crop&w=600&q=80",
  juice: "https://images.unsplash.com/photo-1600271886742-f049cd451bba?auto=format&fit=crop&w=600&q=80",
  ketchup: "https://images.unsplash.com/photo-1628191010210-a59de9c7dad2?auto=format&fit=crop&w=600&q=80",
  prawns: "https://images.unsplash.com/photo-1565680018434-b698b7a50383?auto=format&fit=crop&w=600&q=80",
  cookware: "https://images.unsplash.com/photo-1584990342419-2e0c8e40b849?auto=format&fit=crop&w=600&q=80",
  water: "https://images.unsplash.com/photo-1548839140-29a749e1cf4d?auto=format&fit=crop&w=600&q=80",
  apple: "https://images.unsplash.com/photo-1560806887-1e4cd0b6cbd6?auto=format&fit=crop&w=600&q=80",
  mutton: "https://images.unsplash.com/photo-1603048295942-be79d75e3b9c?auto=format&fit=crop&w=600&q=80",
  packaging: "https://images.unsplash.com/photo-1607083206869-4caa2a3f0e0a?auto=format&fit=crop&w=600&q=80",
  cheese: "https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?auto=format&fit=crop&w=600&q=80",
  snacks: "https://images.unsplash.com/photo-1613919113640-25732cd5a954?auto=format&fit=crop&w=600&q=80",
};

function galleryFor(imageKey, slug) {
  const main = PRODUCT_IMAGES[imageKey] || PRODUCT_IMAGES.snacks;
  const alt = `https://picsum.photos/seed/${slug}-2/600/600`;
  return { mainImage: main, galleryImages: [main, alt] };
}

function hubInventoryStatus(availableQty, reorderLevel = 10) {
  const qty = Math.max(0, Number(availableQty) || 0);
  const reorder = Math.max(0, Number(reorderLevel) || 0);
  if (qty <= 0) return "out_of_stock";
  if (qty <= reorder) return "low_stock";
  return "healthy";
}

async function syncHubStock(product, lowStockAlert) {
  const hubQty = totalVariantStock(product.variants) || Math.max(0, Number(product.stock) || 0);
  const sellPrice =
    Number(product.salePrice) > 0 ? Number(product.salePrice) : Number(product.price) || 0;
  const reorderLevel = Math.max(0, Number(lowStockAlert) || 10);

  await HubInventory.findOneAndUpdate(
    { hubId: DEFAULT_HUB_ID, productId: product._id },
    {
      $set: {
        availableQty: hubQty,
        status: hubInventoryStatus(hubQty, reorderLevel),
        reorderLevel,
        sellPrice,
        priceUpdatedAt: new Date(),
      },
      $setOnInsert: { reservedQty: 0 },
    },
    { upsert: true, new: true },
  );
}

/**
 * parent + sub = exact names from seedCategories.js CATEGORY_CATALOG
 * @type {Array<object>}
 */
const PRODUCT_CATALOG = [
  {
    name: "Amul Taaza Toned Milk",
    parent: "Dairy",
    sub: "Milk",
    brand: "Amul",
    imageKey: "milk",
    isFeatured: true,
    description: "Fresh toned milk for tea, coffee, and kitchen use. Ideal for daily HoReCa consumption.",
    tags: ["milk", "dairy", "toned", "amul"],
    variants: [
      { name: "500 ml", unit: "Pack", price: 32, salePrice: 30, purchasePrice: 24, stock: 140 },
      { name: "1 Litre", unit: "L", price: 62, salePrice: 58, purchasePrice: 47, stock: 95 },
    ],
  },
  {
    name: "Amul Butter Salted",
    parent: "Dairy",
    sub: "Butter",
    brand: "Amul",
    imageKey: "butter",
    description: "Salted table butter for baking, spreading, and commercial kitchen prep.",
    tags: ["butter", "dairy"],
    variants: [
      { name: "100 g", unit: "Pack", price: 58, salePrice: 55, purchasePrice: 44, stock: 80 },
      { name: "500 g", unit: "Pack", price: 275, salePrice: 265, purchasePrice: 210, stock: 45 },
    ],
  },
  {
    name: "Milky Mist Paneer Block",
    parent: "Dairy",
    sub: "Paneer & Cottage Cheese",
    brand: "Milky Mist",
    imageKey: "paneer",
    isFeatured: true,
    description: "Fresh paneer block for gravies, tikkas, and bulk kitchen orders.",
    tags: ["paneer", "dairy", "fresh"],
    variants: [
      { name: "200 g", unit: "Pack", price: 95, salePrice: 89, purchasePrice: 72, stock: 60 },
      { name: "1 kg", unit: "kg", price: 420, salePrice: 399, purchasePrice: 320, stock: 35 },
    ],
  },
  {
    name: "Hybrid Tomatoes (Grade A)",
    parent: "Fruits & Vegetables",
    sub: "Tomatoes & Onions",
    brand: "Farm Fresh",
    imageKey: "tomato",
    description: "Firm red tomatoes sorted for restaurant prep and retail packs.",
    tags: ["vegetables", "tomato", "fresh"],
    variants: [
      { name: "1 kg", unit: "kg", price: 42, salePrice: 38, purchasePrice: 28, stock: 200 },
      { name: "5 kg", unit: "kg", price: 195, salePrice: 180, purchasePrice: 135, stock: 70 },
    ],
  },
  {
    name: "Nasik Red Onion",
    parent: "Fruits & Vegetables",
    sub: "Tomatoes & Onions",
    brand: "Farm Fresh",
    imageKey: "onion",
    description: "Storage onions for bulk kitchen — consistent size and low moisture.",
    tags: ["onion", "vegetables"],
    variants: [
      { name: "1 kg", unit: "kg", price: 38, salePrice: 35, purchasePrice: 26, stock: 250 },
      { name: "10 kg", unit: "kg", price: 340, salePrice: 320, purchasePrice: 240, stock: 55 },
    ],
  },
  {
    name: "Coriander Leaves Bunch",
    parent: "Fruits & Vegetables",
    sub: "Leafy Greens & Herbs",
    brand: "Farm Fresh",
    imageKey: "herbs",
    description: "Washed coriander bunches for garnish and chutney prep.",
    tags: ["herbs", "coriander", "fresh"],
    variants: [
      { name: "1 Bunch", unit: "Bundle", price: 18, salePrice: 15, purchasePrice: 10, stock: 120 },
      { name: "5 Bunch Pack", unit: "Bundle", price: 75, salePrice: 68, purchasePrice: 45, stock: 40 },
    ],
  },
  {
    name: "Organic Fuji Apple",
    parent: "Fruits & Vegetables",
    sub: "Organic Fruits",
    brand: "Organic Harvest",
    imageKey: "apple",
    isFeatured: true,
    description: "Sweet organic apples — good for salads, desserts, and juice bars.",
    tags: ["apple", "organic", "fruit"],
    variants: [
      { name: "500 g", unit: "kg", price: 120, salePrice: 110, purchasePrice: 85, stock: 50 },
      { name: "2 kg", unit: "kg", price: 440, salePrice: 420, purchasePrice: 320, stock: 22 },
    ],
  },
  {
    name: "India Gate Basmati Rice Classic",
    parent: "Rice & Rice Products",
    sub: "Basmati Rice",
    brand: "India Gate",
    imageKey: "rice",
    isFeatured: true,
    description: "Long-grain basmati for biryani and daily rice service.",
    tags: ["rice", "basmati", "staple"],
    variants: [
      { name: "1 kg", unit: "kg", price: 145, salePrice: 138, purchasePrice: 115, stock: 90 },
      { name: "5 kg", unit: "kg", price: 680, salePrice: 649, purchasePrice: 540, stock: 40 },
      { name: "25 kg", unit: "kg", price: 3200, salePrice: 3099, purchasePrice: 2650, stock: 12 },
    ],
  },
  {
    name: "Tata Sampann Toor Dal",
    parent: "Pulses",
    sub: "Toor Dal",
    brand: "Tata Sampann",
    imageKey: "dal",
    description: "Unpolished toor dal for sambar, dal fry, and bulk kitchen.",
    tags: ["dal", "pulses", "toor"],
    variants: [
      { name: "1 kg", unit: "kg", price: 148, salePrice: 142, purchasePrice: 118, stock: 75 },
      { name: "5 kg", unit: "kg", price: 710, salePrice: 685, purchasePrice: 560, stock: 28 },
    ],
  },
  {
    name: "Fortune Refined Sunflower Oil",
    parent: "Edible Oils",
    sub: "Sunflower Oil",
    brand: "Fortune",
    imageKey: "oil",
    description: "Light refined oil for frying, sautéing, and general cooking.",
    tags: ["oil", "sunflower", "cooking"],
    variants: [
      { name: "1 Litre", unit: "L", price: 165, salePrice: 158, purchasePrice: 132, stock: 65 },
      { name: "5 Litre", unit: "L", price: 780, salePrice: 749, purchasePrice: 620, stock: 25 },
    ],
  },
  {
    name: "MDH Garam Masala",
    parent: "Masala, Salt & Sugar",
    sub: "Garam Masala",
    brand: "MDH",
    imageKey: "masala",
    description: "Aromatic garam masala blend for curries and marinades.",
    tags: ["masala", "spice", "mdh"],
    variants: [
      { name: "100 g", unit: "Pack", price: 78, salePrice: 75, purchasePrice: 58, stock: 100 },
      { name: "500 g", unit: "Pack", price: 360, salePrice: 345, purchasePrice: 270, stock: 35 },
    ],
  },
  {
    name: "Fresh Chicken Breast Boneless",
    parent: "Chicken & Eggs",
    sub: "Chicken Breast & Boneless",
    brand: "Licious",
    imageKey: "chicken",
    isFeatured: true,
    description: "Skinless breast cuts for grills, salads, and bulk prep.",
    tags: ["chicken", "protein", "fresh"],
    variants: [
      { name: "500 g", unit: "kg", price: 195, salePrice: 185, purchasePrice: 155, stock: 40 },
      { name: "1 kg", unit: "kg", price: 375, salePrice: 359, purchasePrice: 300, stock: 25 },
    ],
  },
  {
    name: "Farm Fresh Brown Eggs",
    parent: "Chicken & Eggs",
    sub: "Farm Eggs",
    brand: "Happy Hens",
    imageKey: "eggs",
    description: "Brown eggs for bakery, breakfast, and bulk trays.",
    tags: ["eggs", "protein"],
    variants: [
      { name: "6 Pieces", unit: "Pieces", price: 54, salePrice: 52, purchasePrice: 42, stock: 90 },
      { name: "30 Pieces Tray", unit: "Box", price: 255, salePrice: 245, purchasePrice: 200, stock: 30 },
    ],
  },
  {
    name: "Coca-Cola Original",
    parent: "Beverages & Mixers",
    sub: "Soft Drinks",
    brand: "Coca-Cola",
    imageKey: "cola",
    description: "Classic cola for restaurant and cloud-kitchen beverage service.",
    tags: ["beverage", "cola", "soft-drink"],
    variants: [
      { name: "750 ml", unit: "Pack", price: 42, salePrice: 40, purchasePrice: 32, stock: 110 },
      { name: "2.25 Litre", unit: "L", price: 95, salePrice: 89, purchasePrice: 72, stock: 48 },
    ],
  },
  {
    name: "Real Fruit Power Orange Juice",
    parent: "Beverages & Mixers",
    sub: "Fruit Juices",
    brand: "Real",
    imageKey: "juice",
    description: "Ready-to-serve orange juice for breakfast and buffet.",
    tags: ["juice", "beverage"],
    variants: [
      { name: "1 Litre", unit: "L", price: 115, salePrice: 108, purchasePrice: 88, stock: 55 },
      { name: "2 Litre", unit: "L", price: 210, salePrice: 199, purchasePrice: 165, stock: 28 },
    ],
  },
  {
    name: "Bisleri Packaged Water",
    parent: "Beverages & Mixers",
    sub: "Water & Soda",
    brand: "Bisleri",
    imageKey: "water",
    description: "Packaged drinking water for kitchen, staff, and customer packs.",
    tags: ["water", "beverage"],
    variants: [
      { name: "1 Litre", unit: "Pack", price: 20, salePrice: 18, purchasePrice: 14, stock: 200 },
      { name: "5 Litre", unit: "L", price: 75, salePrice: 70, purchasePrice: 55, stock: 80 },
    ],
  },
  {
    name: "Britannia Good Day Cashew Cookies",
    parent: "Bakery & Chocolates",
    sub: "Cookies & Biscuits",
    brand: "Britannia",
    imageKey: "biscuit",
    description: "Cashew cookies for pantry, tea service, and add-on sales.",
    tags: ["biscuit", "bakery", "snacks"],
    variants: [
      { name: "75 g", unit: "Pack", price: 25, salePrice: 24, purchasePrice: 18, stock: 150 },
      { name: "1 kg Bulk", unit: "kg", price: 280, salePrice: 265, purchasePrice: 220, stock: 20 },
    ],
  },
  {
    name: "Amul Processed Cheese Slices",
    parent: "Dairy",
    sub: "Cheese",
    brand: "Amul",
    imageKey: "cheese",
    description: "Cheese slices for burgers, sandwiches, and melts.",
    tags: ["cheese", "dairy"],
    variants: [
      { name: "100 g (10 slices)", unit: "Pack", price: 125, salePrice: 119, purchasePrice: 95, stock: 70 },
      { name: "400 g", unit: "Pack", price: 460, salePrice: 439, purchasePrice: 360, stock: 25 },
    ],
  },
  {
    name: "Aashirvaad Select Sharbati Atta",
    parent: "Flours",
    sub: "Whole Wheat Atta",
    brand: "Aashirvaad",
    imageKey: "atta",
    isFeatured: true,
    description: "Premium wheat atta for roti, paratha, and bakery prep.",
    tags: ["atta", "flour", "wheat"],
    variants: [
      { name: "5 kg", unit: "kg", price: 285, salePrice: 275, purchasePrice: 230, stock: 50 },
      { name: "10 kg", unit: "kg", price: 540, salePrice: 519, purchasePrice: 440, stock: 22 },
    ],
  },
  {
    name: "Happilo Premium Almonds",
    parent: "Dry Fruits & Nuts",
    sub: "Almonds",
    brand: "Happilo",
    imageKey: "almonds",
    description: "California almonds for sweets, garnishing, and bulk kitchen.",
    tags: ["dry-fruits", "almonds", "nuts"],
    variants: [
      { name: "250 g", unit: "Pack", price: 285, salePrice: 269, purchasePrice: 220, stock: 45 },
      { name: "1 kg", unit: "kg", price: 1080, salePrice: 1049, purchasePrice: 860, stock: 18 },
    ],
  },
  {
    name: "McCain Green Peas Frozen",
    parent: "Frozen & Instant Food",
    sub: "Frozen Vegetables",
    brand: "McCain",
    imageKey: "frozen",
    description: "IQF green peas for curries, fried rice, and quick prep.",
    tags: ["frozen", "peas", "vegetables"],
    variants: [
      { name: "400 g", unit: "Pack", price: 95, salePrice: 89, purchasePrice: 72, stock: 60 },
      { name: "2.5 kg", unit: "kg", price: 520, salePrice: 499, purchasePrice: 410, stock: 15 },
    ],
  },
  {
    name: "Maggi 2-Minute Masala Noodles",
    parent: "Frozen & Instant Food",
    sub: "Instant Noodles",
    brand: "Maggi",
    imageKey: "noodles",
    description: "Instant noodles for staff meals, add-ons, and quick service.",
    tags: ["maggi", "instant", "noodles"],
    variants: [
      { name: "70 g", unit: "Pack", price: 14, salePrice: 14, purchasePrice: 11, stock: 300 },
      { name: "12 Pack Box", unit: "Box", price: 155, salePrice: 148, purchasePrice: 125, stock: 45 },
    ],
  },
  {
    name: "Heinz Tomato Ketchup",
    parent: "Sauces & Seasoning",
    sub: "Tomato Ketchup",
    brand: "Heinz",
    imageKey: "ketchup",
    description: "Thick tomato ketchup for fries, burgers, and condiment stations.",
    tags: ["ketchup", "sauce", "condiment"],
    variants: [
      { name: "500 g", unit: "Pack", price: 125, salePrice: 119, purchasePrice: 95, stock: 65 },
      { name: "1 kg", unit: "kg", price: 230, salePrice: 219, purchasePrice: 175, stock: 30 },
    ],
  },
  {
    name: "Medium Prawns Cleaned",
    parent: "Fish, Prawns & Seafood",
    sub: "Prawns & Shrimps",
    brand: "Sea Fresh",
    imageKey: "prawns",
    description: "Deveined medium prawns for curries, grills, and bulk orders.",
    tags: ["seafood", "prawns"],
    variants: [
      { name: "500 g", unit: "kg", price: 320, salePrice: 305, purchasePrice: 260, stock: 25 },
      { name: "1 kg", unit: "kg", price: 620, salePrice: 589, purchasePrice: 500, stock: 12 },
    ],
  },
  {
    name: "Goat Mutton Curry Cut",
    parent: "Mutton, Duck & Lamb",
    sub: "Mutton Curry Cut",
    brand: "Licious",
    imageKey: "mutton",
    description: "Curry-cut mutton pieces for biryani, curry, and slow cooking.",
    tags: ["mutton", "meat"],
    variants: [
      { name: "500 g", unit: "kg", price: 385, salePrice: 369, purchasePrice: 310, stock: 18 },
      { name: "1 kg", unit: "kg", price: 750, salePrice: 719, purchasePrice: 600, stock: 10 },
    ],
  },
  {
    name: "Harpic Power Plus Toilet Cleaner",
    parent: "Cleaning & Consumables",
    sub: "Toilet Cleaners",
    brand: "Harpic",
    imageKey: "cleaner",
    description: "Toilet cleaner for outlet hygiene and housekeeping.",
    tags: ["cleaning", "hygiene"],
    variants: [
      { name: "500 ml", unit: "ml", price: 95, salePrice: 89, purchasePrice: 72, stock: 55 },
      { name: "1 Litre", unit: "L", price: 175, salePrice: 165, purchasePrice: 130, stock: 28 },
    ],
  },
  {
    name: "Surf Excel Matic Top Load",
    parent: "Cleaning & Consumables",
    sub: "Laundry Detergent",
    brand: "Surf Excel",
    imageKey: "detergent",
    description: "Laundry detergent for staff uniforms and linen.",
    tags: ["detergent", "laundry"],
    variants: [
      { name: "1 kg", unit: "kg", price: 285, salePrice: 269, purchasePrice: 220, stock: 40 },
      { name: "4 kg", unit: "kg", price: 980, salePrice: 949, purchasePrice: 780, stock: 15 },
    ],
  },
  {
    name: "Prestige Non-Stick Tawa 28cm",
    parent: "Kitchenware",
    sub: "Kadai & Tawa",
    brand: "Prestige",
    imageKey: "cookware",
    description: "Non-stick tawa for roti, dosa, and flatbread stations.",
    tags: ["kitchenware", "tawa"],
    variants: [
      { name: "28 cm", unit: "Pieces", price: 899, salePrice: 849, purchasePrice: 680, stock: 20 },
    ],
  },
  {
    name: "EcoPack Clamshell Container 750ml",
    parent: "Packaging Material",
    sub: "Clamshell & Hinged Boxes",
    brand: "EcoPack",
    imageKey: "packaging",
    description: "Food-grade clamshell boxes for takeaway and delivery.",
    tags: ["packaging", "disposable"],
    variants: [
      { name: "50 pcs", unit: "Box", price: 420, salePrice: 399, purchasePrice: 320, stock: 35 },
      { name: "200 pcs", unit: "Box", price: 1550, salePrice: 1499, purchasePrice: 1200, stock: 12 },
    ],
  },
  {
    name: "Haldiram Bhujia Sev",
    parent: "Your Menu Add-ons",
    sub: "Appetizers & Starters",
    brand: "Haldiram",
    imageKey: "snacks",
    description: "Crispy bhujia for chaat counters, sides, and snack add-ons.",
    tags: ["snacks", "namkeen", "addon"],
    variants: [
      { name: "200 g", unit: "Pack", price: 55, salePrice: 52, purchasePrice: 42, stock: 85 },
      { name: "1 kg", unit: "kg", price: 240, salePrice: 229, purchasePrice: 185, stock: 30 },
    ],
  },
  {
    name: "Tata Salt Iodized",
    parent: "Masala, Salt & Sugar",
    sub: "Salt",
    brand: "Tata",
    imageKey: "masala",
    description: "Iodized salt for everyday cooking and bulk kitchen.",
    tags: ["salt", "staple"],
    variants: [
      { name: "1 kg", unit: "kg", price: 28, salePrice: 26, purchasePrice: 20, stock: 180 },
      { name: "5 kg", unit: "kg", price: 125, salePrice: 118, purchasePrice: 95, stock: 50 },
    ],
  },
];

async function buildCategoryIndex() {
  const rows = await Category.find({ status: "active" }).lean();
  const bySlug = new Map();
  for (const row of rows) {
    bySlug.set(row.slug, row);
  }
  return bySlug;
}

function resolveCategoryIds(bySlug, parentName, subName) {
  const pSlug = slugify(parentName);
  const sSlug = subSlug(parentName, subName);
  const parent = bySlug.get(pSlug);
  const sub = bySlug.get(sSlug);
  if (!parent) {
    throw new Error(`Parent category not found: "${parentName}" (slug: ${pSlug})`);
  }
  if (!sub) {
    throw new Error(
      `Subcategory not found: "${subName}" under "${parentName}" (slug: ${sSlug}). Run seed:categories first.`,
    );
  }
  if (String(sub.parentId) !== String(parent._id)) {
    throw new Error(`Subcategory "${subName}" is not a child of "${parentName}"`);
  }
  return { categoryId: parent._id, subcategoryId: sub._id };
}

async function clearSeedProducts() {
  const seedProducts = await Product.find({ tags: SEED_TAG }).select("_id").lean();
  const ids = seedProducts.map((p) => p._id);
  if (!ids.length) {
    console.log("No previous seed products to clear");
    return;
  }
  await HubInventory.deleteMany({ productId: { $in: ids } });
  const deleted = await Product.deleteMany({ _id: { $in: ids } });
  console.log(`Cleared ${deleted.deletedCount} seed products and hub inventory rows`);
}

async function upsertSeedProduct(row, bySlug) {
  const { categoryId, subcategoryId } = resolveCategoryIds(bySlug, row.parent, row.sub);
  const slug = await ensureUniqueSlug(row.name);
  const { mainImage, galleryImages } = galleryFor(row.imageKey, slug);

  const defaultUnit = row.variants[0]?.unit || "Pieces";
  const productData = {
    name: row.name,
    slug,
    description: row.description || "",
    brand: row.brand || "",
    categoryId,
    subcategoryId,
    ownerType: "admin",
    sellerId: null,
    status: "active",
    isFeatured: Boolean(row.isFeatured),
    lowStockAlert: row.lowStockAlert ?? 10,
    unit: defaultUnit,
    tags: [...(row.tags || []), SEED_TAG],
    mainImage,
    galleryImages,
    variants: normalizeVariants(row.variants, {
      defaultUnit,
      basePrice: row.variants[0]?.price || 0,
      baseSalePrice: row.variants[0]?.salePrice || row.variants[0]?.price || 0,
    }),
  };

  syncRootFromFirstVariant(productData);

  const existing = await Product.findOne({ slug: productData.slug }).lean();
  let product;
  if (existing) {
    product = await Product.findByIdAndUpdate(
      existing._id,
      { $set: productData },
      { new: true, runValidators: true },
    );
  } else {
    product = await Product.create(productData);
  }

  await syncHubStock(product, productData.lowStockAlert);
  return product;
}

async function seed() {
  const clearFirst = process.argv.includes("--clear");
  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("MONGO_URI is missing in backend/.env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("Connected to MongoDB");

  try {
    await Product.syncLegacyIndexes?.();
  } catch (err) {
    console.warn("[seedProducts] syncLegacyIndexes:", err.message);
  }

  if (clearFirst) {
    await clearSeedProducts();
  }

  const bySlug = await buildCategoryIndex();
  const parentCount = [...bySlug.values()].filter((c) => c.type === "category").length;
  const subCount = [...bySlug.values()].filter((c) => c.type === "subcategory").length;
  console.log(`Categories in DB: ${parentCount} parents, ${subCount} subcategories`);

  if (parentCount === 0) {
    console.error("No categories found. Run: npm run seed:categories");
    process.exit(1);
  }

  let created = 0;
  let failed = 0;

  for (const row of PRODUCT_CATALOG) {
    try {
      const product = await upsertSeedProduct(row, bySlug);
      const variantCount = product.variants?.length || 0;
      const stock = totalVariantStock(product.variants) || product.stock;
      console.log(`✓ ${product.name} (${variantCount} variants, hub stock ${stock})`);
      created += 1;
    } catch (err) {
      failed += 1;
      console.error(`✗ ${row.name}: ${err.message}`);
    }
  }

  console.log("\n--- Product seed complete ---");
  console.log(`Seeded:  ${created}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Total:   ${PRODUCT_CATALOG.length} in catalog`);
  console.log(`Hub:     ${DEFAULT_HUB_ID}`);
  console.log(`Tag:     ${SEED_TAG} (use --clear to replace)`);

  await mongoose.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
