/**
 * Seed main categories + subcategories (Hyperpure / B2B grocery style catalog).
 *
 * Usage (from backend/):
 *   node scripts/seedCategories.js
 *   node scripts/seedCategories.js --clear   # delete all categories first, then seed
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

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** @type {Array<{ name: string, slug?: string, description?: string, order: number, subcategories: string[] }>} */
const CATEGORY_CATALOG = [
  {
    name: "Your Menu Add-ons",
    order: 1,
    description: "Ready meals, sides, and add-ons for your menu",
    subcategories: [
      "Ready-to-Eat Meals",
      "Biryani & Rice Meals",
      "Curries & Gravies",
      "Kebabs & Tandoor Items",
      "Appetizers & Starters",
      "Side Dishes",
      "Meal Kits",
      "Party Platters",
      "Breakfast Add-ons",
      "Desserts for Menu",
    ],
  },
  {
    name: "Fruits & Vegetables",
    order: 2,
    description: "Fresh produce for kitchen and retail",
    subcategories: [
      "Fresh Vegetables",
      "Fresh Fruits",
      "Leafy Greens & Herbs",
      "Exotic Vegetables",
      "Exotic Fruits",
      "Seasonal Fruits",
      "Organic Vegetables",
      "Organic Fruits",
      "Pre-cut & Peeled",
      "Hydroponic Produce",
      "Root Vegetables",
      "Tomatoes & Onions",
      "Potatoes & Onions Combo",
    ],
  },
  {
    name: "Dairy",
    order: 3,
    description: "Milk, curd, cheese, and dairy essentials",
    subcategories: [
      "Milk",
      "Toned & Double Toned Milk",
      "Full Cream Milk",
      "Flavoured Milk",
      "Curd & Yogurt",
      "Greek Yogurt",
      "Paneer & Cottage Cheese",
      "Cheese",
      "Butter",
      "Ghee",
      "Cream & Malai",
      "Condensed Milk",
      "Buttermilk & Lassi",
      "Ice Cream Bases",
      "Dairy Alternatives",
    ],
  },
  {
    name: "Masala, Salt & Sugar",
    order: 4,
    description: "Spices, blends, salt, and sweeteners",
    subcategories: [
      "Blended Masalas",
      "Whole Spices",
      "Basic Spices",
      "Turmeric & Chilli Powder",
      "Coriander & Cumin",
      "Garam Masala",
      "Kitchen King & Sabzi Masala",
      "Meat & Fish Masala",
      "Salt",
      "Rock & Pink Salt",
      "Sugar",
      "Jaggery & Gur",
      "Brown & Demerara Sugar",
      "Artificial Sweeteners",
      "Papad & Fryums Masala",
    ],
  },
  {
    name: "Chicken & Eggs",
    order: 5,
    description: "Fresh chicken and eggs for food service",
    subcategories: [
      "Fresh Chicken",
      "Chicken Curry Cut",
      "Chicken Breast & Boneless",
      "Chicken Wings & Legs",
      "Chicken Mince",
      "Marinated Chicken",
      "Frozen Chicken",
      "Country Eggs",
      "Farm Eggs",
      "Duck Eggs",
      "Quail Eggs",
      "Egg Trays Bulk",
    ],
  },
  {
    name: "Sauces & Seasoning",
    order: 6,
    description: "Sauces, condiments, and seasonings",
    subcategories: [
      "Tomato Ketchup",
      "Chilli & Hot Sauce",
      "Pasta & Pizza Sauce",
      "Mayonnaise",
      "Mustard & Spread",
      "Salad Dressings",
      "Vinegar",
      "Soy & Chilli Sauce",
      "Worcestershire & BBQ Sauce",
      "Pizza & Pasta Seasoning",
      "Herbs & Seasonings",
      "Oregano & Mixed Herbs",
      "Black Pepper & Seasoning",
      "Chinese Sauces",
      "Indian Chutneys",
    ],
  },
  {
    name: "Canned & Imported Items",
    order: 7,
    description: "Imported and canned pantry goods",
    subcategories: [
      "Canned Vegetables",
      "Canned Fruits",
      "Canned Beans & Pulses",
      "Canned Meat & Fish",
      "Imported Snacks",
      "Imported Sauces",
      "Gourmet Oils",
      "Imported Cheese",
      "Olives & Pickles",
      "Baked Beans & Corn",
      "Coconut Milk & Cream",
      "Imported Beverages",
      "International Breakfast",
    ],
  },
  {
    name: "Packaging Material",
    order: 8,
    description: "Disposables and packaging for outlets",
    subcategories: [
      "Disposable Containers",
      "Aluminium Foil & Wrap",
      "Food Grade Bags",
      "Carry Bags",
      "Clamshell & Hinged Boxes",
      "Paper Boxes & Cartons",
      "Cups & Lids",
      "Cutlery & Straws",
      "Tissue & Napkins",
      "Burger & Pizza Boxes",
      "Sauce Cups & Lids",
      "Bubble Wrap & Padding",
    ],
  },
  {
    name: "Custom Packaging",
    order: 9,
    description: "Branded and custom print packaging",
    subcategories: [
      "Branded Carry Bags",
      "Custom Printed Boxes",
      "Personalized Labels",
      "Custom Tapes",
      "Printed Cups & Sleeves",
      "Menu Inserts & Cards",
      "Branded Tissue & Napkins",
      "Custom Stickers",
    ],
  },
  {
    name: "Edible Oils",
    order: 10,
    description: "Cooking and frying oils",
    subcategories: [
      "Mustard Oil",
      "Sunflower Oil",
      "Rice Bran Oil",
      "Soyabean Oil",
      "Groundnut Oil",
      "Palm & Vegetable Oil",
      "Olive Oil",
      "Coconut Oil",
      "Sesame Oil",
      "Blended Cooking Oil",
      "Frying Oil Bulk",
      "Filtered & Refined Oil",
    ],
  },
  {
    name: "Frozen & Instant Food",
    order: 11,
    description: "Frozen snacks and instant mixes",
    subcategories: [
      "Frozen Snacks",
      "Frozen Fries & Potatoes",
      "Frozen Paratha & Bread",
      "Frozen Vegetables",
      "Instant Noodles",
      "Instant Pasta",
      "Soup & Broth Mix",
      "Ready-to-Cook Mixes",
      "Frozen Desserts",
      "Frozen Seafood",
      "Frozen Momos & Snacks",
      "Instant Breakfast",
    ],
  },
  {
    name: "Bakery & Chocolates",
    order: 12,
    description: "Bakery items, chocolates, and baking needs",
    subcategories: [
      "Breads & Buns",
      "Pav & Burger Buns",
      "Cakes & Pastries",
      "Cookies & Biscuits",
      "Chocolates",
      "Compound Chocolate",
      "Baking Flour & Mix",
      "Yeast & Baking Powder",
      "Cocoa & Chocolate Chips",
      "Cream & Toppings",
      "Dry Fruits for Baking",
      "Essence & Food Colour",
      "Sugar Craft Supplies",
    ],
  },
  {
    name: "Beverages & Mixers",
    order: 13,
    description: "Drinks, juices, tea, coffee, and mixers",
    subcategories: [
      "Soft Drinks",
      "Fruit Juices",
      "Concentrates & Syrups",
      "Energy Drinks",
      "Tea",
      "Green & Herbal Tea",
      "Coffee",
      "Instant Coffee",
      "Milkshakes & Lassi",
      "Water & Soda",
      "Mocktail Mixers",
      "Bar Mixers",
      "Bulk Beverage",
    ],
  },
  {
    name: "Cleaning & Consumables",
    order: 14,
    description: "Cleaning supplies for kitchen and outlet",
    subcategories: [
      "Floor Cleaners",
      "Surface & Glass Cleaner",
      "Dishwashing Liquid",
      "Dishwash Bars",
      "Laundry Detergent",
      "Fabric Softener",
      "Toilet Cleaners",
      "Hand Wash & Sanitizer",
      "Garbage Bags",
      "Scrubbers & Wipes",
      "Mops & Brooms",
      "Bleach & Disinfectant",
      "Air Fresheners",
    ],
  },
  {
    name: "Flours",
    order: 15,
    description: "Atta, maida, and specialty flours",
    subcategories: [
      "Whole Wheat Atta",
      "Multigrain Atta",
      "Maida",
      "Besan",
      "Rice Flour",
      "Corn Flour",
      "Ragi & Millet Flour",
      "Sooji & Rava",
      "Baking Maida",
      "Gluten Free Flour",
      "Bulk Atta Bags",
    ],
  },
  {
    name: "Pulses",
    order: 16,
    description: "Dals, lentils, and legumes",
    subcategories: [
      "Toor Dal",
      "Moong Dal",
      "Masoor Dal",
      "Chana Dal",
      "Urad Dal",
      "Rajma",
      "Kabuli Chana",
      "Kala Chana",
      "Lobia & Whole Pulses",
      "Split Pulses",
      "Organic Pulses",
      "Bulk Pulses",
    ],
  },
  {
    name: "Dry Fruits & Nuts",
    order: 17,
    description: "Nuts, dry fruits, and seeds",
    subcategories: [
      "Almonds",
      "Cashews",
      "Walnuts",
      "Pistachios",
      "Raisins",
      "Dates",
      "Dried Figs & Apricot",
      "Mixed Dry Fruits",
      "Seeds & Berries",
      "Roasted Nuts",
      "Bulk Dry Fruits",
    ],
  },
  {
    name: "Rice & Rice Products",
    order: 18,
    description: "Rice, poha, and rice-based products",
    subcategories: [
      "Basmati Rice",
      "Premium Basmati",
      "Non-Basmati Rice",
      "Sona Masoori & Kolam",
      "Brown & Red Rice",
      "Poha",
      "Murmura & Puffed Rice",
      "Rice Flakes",
      "Broken Rice",
      "Bulk Rice Bags",
    ],
  },
  {
    name: "Mutton, Duck & Lamb",
    order: 19,
    description: "Red meat and specialty cuts",
    subcategories: [
      "Goat Mutton",
      "Mutton Curry Cut",
      "Mutton Boneless",
      "Lamb Chops",
      "Lamb Mince",
      "Duck Meat",
      "Lamb Leg & Rack",
      "Organ Meats",
      "Marinated Mutton",
      "Frozen Mutton",
    ],
  },
  {
    name: "Fish, Prawns & Seafood",
    order: 20,
    description: "Fresh and frozen seafood",
    subcategories: [
      "Fresh Water Fish",
      "Sea Fish",
      "Pomfret & Surmai",
      "Rohu & Catla",
      "Prawns & Shrimps",
      "Crab & Shellfish",
      "Squid & Calamari",
      "Fish Fillets",
      "Marinated Seafood",
      "Frozen Seafood",
      "Dry Fish",
    ],
  },
  {
    name: "Kitchenware",
    order: 21,
    description: "Cookware, tools, and serveware",
    subcategories: [
      "Cookware Sets",
      "Kadai & Tawa",
      "Saucepan & Stock Pot",
      "Non-stick Cookware",
      "Knives & Cutting Tools",
      "Peelers & Graters",
      "Ladles & Spoons",
      "Tongs & Whisks",
      "Strainers & Colanders",
      "Serveware",
      "Plates & Bowls",
      "Glasses & Cups",
      "Storage Containers",
      "Gas Stove Accessories",
    ],
  },
];

async function upsertCategory(doc) {
  return Category.findOneAndUpdate(
    { slug: doc.slug },
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
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

  if (clearFirst) {
    const deleted = await Category.deleteMany({});
    console.log(`Cleared ${deleted.deletedCount} existing category documents`);
  }

  let parentCount = 0;
  let subCount = 0;

  for (const row of CATEGORY_CATALOG) {
    const parentSlug = row.slug || slugify(row.name);

    const parent = await upsertCategory({
      name: row.name,
      slug: parentSlug,
      description: row.description || "",
      type: "category",
      parentId: null,
      status: "active",
      order: row.order,
      image: row.image || "",
    });
    parentCount += 1;

    let subOrder = 1;
    for (const subName of row.subcategories) {
      const subSlug = `${parentSlug}-${slugify(subName)}`;
      await upsertCategory({
        name: subName,
        slug: subSlug,
        description: `${subName} — ${row.name}`,
        type: "subcategory",
        parentId: parent._id,
        status: "active",
        order: subOrder,
        image: "",
      });
      subOrder += 1;
      subCount += 1;
    }

    console.log(`✓ ${row.name} (${row.subcategories.length} subcategories)`);
  }

  console.log("\n--- Seed complete ---");
  console.log(`Parent categories: ${parentCount}`);
  console.log(`Subcategories:     ${subCount}`);
  console.log(`Total documents:   ${parentCount + subCount}`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
