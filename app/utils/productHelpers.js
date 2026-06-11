import mongoose from "mongoose";

/** Supported sell units (matches admin/seller UI). */
export const PRODUCT_UNITS = [
  "Pieces",
  "kg",
  "g",
  "L",
  "ml",
  "Pack",
  "Box",
  "Bundle",
];

export function normalizeUnit(unit, fallback = "Pieces") {
  const u = String(unit || "").trim();
  return PRODUCT_UNITS.includes(u) ? u : fallback;
}

export function normalizeProductName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * Canonical variant identity for duplicate detection.
 * Same product name + same signature = same catalog item.
 * Different variant rows (name + unit) = allowed as a separate product.
 */
export function buildVariantSignature(variants = [], rootUnit = "Pieces") {
  const unit = normalizeUnit(rootUnit);
  const rows =
    Array.isArray(variants) && variants.length > 0
      ? variants
      : [{ name: "default", unit }];

  return rows
    .map((v) => {
      const n = String(v?.name || "default").trim().toLowerCase();
      const u = normalizeUnit(v?.unit, unit).toLowerCase();
      return `${n}|${u}`;
    })
    .sort()
    .join(";");
}

export function variantsShareSignature(leftVariants, leftUnit, rightVariants, rightUnit) {
  return (
    buildVariantSignature(leftVariants, leftUnit) ===
    buildVariantSignature(rightVariants, rightUnit)
  );
}

export function parseVariantsField(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

/**
 * Normalize variant rows for persistence. Each variant keeps its own stock.
 */
export function normalizeVariants(variants, opts = {}) {
  const {
    defaultUnit = "Pieces",
    basePrice = 0,
    baseSalePrice = 0,
  } = opts;

  if (!Array.isArray(variants) || !variants.length) return [];

  return variants.map((v, index) => {
    const name = String(v?.name || "").trim() || `Variant ${index + 1}`;
    const rawMrp = Number(v?.price);
    const rawSale = Number(v?.salePrice);
    const purchase = Number(v?.purchasePrice);
    const stock = Number(v?.stock);

    const salePrice = Number.isFinite(rawSale) && rawSale >= 0
      ? rawSale
      : Number.isFinite(rawMrp) && rawMrp >= 0
        ? rawMrp
        : baseSalePrice;

    const price = Number.isFinite(rawMrp) && rawMrp >= 0
      ? Math.max(rawMrp, salePrice)
      : salePrice > 0
        ? salePrice
        : basePrice;

    const variantId = v?._id || v?.id;
    const row = {
      name,
      unit: normalizeUnit(v?.unit, defaultUnit),
      price,
      salePrice,
      purchasePrice: Number.isFinite(purchase) && purchase >= 0 ? purchase : 0,
      stock: Number.isFinite(stock) && stock >= 0 ? stock : 0,
    };
    if (variantId && mongoose.Types.ObjectId.isValid(String(variantId))) {
      row._id = variantId;
    }
    return row;
  });
}

/** Variant rows for stock picker UI / API errors. */
export function listVariantsForStockPicker(product) {
  const variants = product?.variants || [];
  return variants.map((v, index) => {
    const plain = v?.toObject ? v.toObject() : v;
    return {
      variantId: plain?._id ? String(plain._id) : null,
      index,
      name: String(plain?.name || "").trim() || `Variant ${index + 1}`,
      stock: Math.max(0, Number(plain?.stock) || 0),
      unit: plain?.unit || product?.unit || "Pieces",
    };
  });
}

/**
 * Resolve which variant row to update (variantId preferred, then index, then name).
 * Returns -1 if not found; -2 if product has variants but no selector was given.
 */
export function resolveVariantIndex(product, opts = {}) {
  const { variantId, variantIndex, variantName } = opts;
  const variants = product?.variants || [];
  if (!variants.length) return variants.length === 0 ? -1 : -2;

  const hasSelector =
    (variantId !== undefined && variantId !== null && String(variantId).trim() !== "") ||
    (variantIndex !== undefined && variantIndex !== null && variantIndex !== "") ||
    (variantName !== undefined && variantName !== null && String(variantName).trim() !== "");

  if (!hasSelector) return -2;

  if (variantId !== undefined && variantId !== null && String(variantId).trim() !== "") {
    const idStr = String(variantId).trim();
    const byId = variants.findIndex((v) => String(v?._id) === idStr);
    if (byId >= 0) return byId;
  }

  if (variantIndex !== undefined && variantIndex !== null && variantIndex !== "") {
    const idx = Number(variantIndex);
    if (Number.isInteger(idx) && idx >= 0 && idx < variants.length) return idx;
  }

  if (variantName !== undefined && variantName !== null && String(variantName).trim() !== "") {
    const target = String(variantName).trim().toLowerCase();
    const byName = variants.findIndex(
      (v) => String(v?.name || "").trim().toLowerCase() === target,
    );
    if (byName >= 0) return byName;
  }

  return -1;
}

/** Clone variant subdocs and set stock on one row; returns plain variant objects. */
export function setVariantStockAtIndex(variants, index, stock) {
  const qty = Math.max(0, Number(stock) || 0);
  return (variants || []).map((v, i) => {
    const plain = v?.toObject ? v.toObject() : { ...v };
    const row = {
      name: plain.name,
      unit: plain.unit,
      price: plain.price,
      salePrice: plain.salePrice,
      purchasePrice: plain.purchasePrice,
      stock: i === index ? qty : Math.max(0, Number(plain.stock) || 0),
    };
    if (plain._id) row._id = plain._id;
    return row;
  });
}

export function variantStockRequiresSelection(product) {
  return Array.isArray(product?.variants) && product.variants.length > 0;
}

/** Customer-facing sell amount (prefers salePrice over list/MRP). */
export function effectiveSellingPrice(productData) {
  const rootSale = Number(productData?.salePrice);
  const rootMrp = Number(productData?.price);
  if (Number.isFinite(rootSale) && rootSale > 0) return rootSale;
  if (Number.isFinite(rootMrp) && rootMrp > 0) return rootMrp;
  const first = productData?.variants?.[0];
  if (!first) return 0;
  const vSale = Number(first.salePrice);
  const vMrp = Number(first.price);
  if (Number.isFinite(vSale) && vSale > 0) return vSale;
  if (Number.isFinite(vMrp) && vMrp > 0) return vMrp;
  return 0;
}

export function totalVariantStock(variants) {
  if (!Array.isArray(variants) || !variants.length) return 0;
  return variants.reduce((sum, v) => sum + (Number(v?.stock) || 0), 0);
}

/** Sellable quantity: sum of variant stocks, else root product stock. */
export function effectiveProductStock(product) {
  const variantSum = totalVariantStock(product?.variants);
  if (variantSum > 0) return variantSum;
  return Math.max(0, Number(product?.stock) || 0);
}

/** Catalog stock stored on the product document (not hub + seller). */
export function catalogStockFromProduct(product) {
  const variantSum = totalVariantStock(product?.variants);
  if (variantSum > 0) return variantSum;
  return Math.max(0, Number(product?.stock) || 0);
}

/** MongoDB expression: variant sum or root stock (for aggregations). */
export const MONGO_CATALOG_STOCK_EXPR = {
  $cond: {
    if: {
      $and: [{ $isArray: "$variants" }, { $gt: [{ $size: "$variants" }, 0] }],
    },
    then: {
      $reduce: {
        input: "$variants",
        initialValue: 0,
        in: { $add: ["$$value", { $ifNull: ["$$this.stock", 0] }] },
      },
    },
    else: { $ifNull: ["$stock", 0] },
  },
};

/** Stock filter: in-stock if root or any variant has qty > 0. */
export function buildSellerStockStatusQuery(stockStatus) {
  if (stockStatus === "in") {
    return {
      $or: [{ stock: { $gt: 0 } }, { variants: { $elemMatch: { stock: { $gt: 0 } } } }],
    };
  }
  if (stockStatus === "out") {
    return {
      $and: [
        { $or: [{ stock: { $lte: 0 } }, { stock: { $exists: false } }] },
        {
          $or: [
            { variants: { $exists: false } },
            { variants: { $size: 0 } },
            { variants: { $not: { $elemMatch: { stock: { $gt: 0 } } } } },
          ],
        },
      ],
    };
  }
  return null;
}

/** Enrich lean product row with normalized catalog stock fields. */
export function enrichSellerProductRow(product) {
  if (!product || typeof product !== "object") return product;
  const catalogStock = catalogStockFromProduct(product);
  return {
    ...product,
    stock: catalogStock,
    catalogStock,
    availableQtySeller: catalogStock,
  };
}

/** Hub row qty (lean HubInventory or API-mapped row). */
export function hubQtyFromInventoryRow(row) {
  if (!row) return 0;
  return Math.max(0, Number(row.availableQty ?? row.hubStockQuantity ?? 0) || 0);
}

/** Split hub total across variant rows (keeps ratios; single variant gets full qty). */
export function distributeQtyAcrossVariants(totalQty, variants = []) {
  const qty = Math.max(0, Number(totalQty) || 0);
  if (!Array.isArray(variants) || !variants.length) return variants;

  const rows = variants.map((v) => ({
    ...v,
    stock: Math.max(0, Number(v?.stock) || 0),
  }));

  if (rows.length === 1) {
    rows[0].stock = qty;
    return rows;
  }

  const sum = rows.reduce((s, v) => s + v.stock, 0);
  if (sum <= 0) {
    rows[0].stock = qty;
    for (let i = 1; i < rows.length; i++) rows[i].stock = 0;
    return rows;
  }

  let assigned = 0;
  for (let i = 0; i < rows.length; i++) {
    if (i === rows.length - 1) {
      rows[i].stock = Math.max(0, qty - assigned);
    } else {
      const part = Math.floor((qty * rows[i].stock) / sum);
      rows[i].stock = part;
      assigned += part;
    }
  }
  return rows;
}

/** Fields clients may set; slug is always generated server-side. */
export const PRODUCT_WRITABLE_KEYS = [
  "name",
  "description",
  "price",
  "salePrice",
  "purchasePrice",
  "stock",
  "lowStockAlert",
  "brand",
  "weight",
  "unit",
  "tags",
  "categoryId",
  "subcategoryId",
  "status",
  "isFeatured",
  "masterProductId",
  "variants",
];

export function pickWritableProductFields(body) {
  const out = {};
  for (const k of PRODUCT_WRITABLE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, k)) out[k] = body[k];
  }
  return out;
}

export function stripDeprecatedProductFields(data) {
  delete data.slug;
  delete data.sku;
  delete data.headerId;
  delete data.gstRate;
  return data;
}

export function parseBooleanField(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** Normalize multipart / JSON body values before save. */
export function normalizeProductBodyFields(data) {
  const numericKeys = [
    "price",
    "salePrice",
    "purchasePrice",
    "stock",
    "lowStockAlert",
  ];
  for (const key of numericKeys) {
    if (data[key] !== undefined && data[key] !== "") {
      const n = Number(data[key]);
      if (Number.isFinite(n)) data[key] = n;
    }
  }

  if (data.isFeatured !== undefined) {
    data.isFeatured = parseBooleanField(data.isFeatured);
  }

  if (data.masterProductId === "" || data.masterProductId === "null") {
    delete data.masterProductId;
  }

  if (typeof data.tags === "string") {
    data.tags = data.tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  if (data.unit) data.unit = normalizeUnit(data.unit);

  return data;
}

/** Root price/stock mirror first variant (legacy fields + home card). */
export function syncRootFromFirstVariant(productData) {
  const variants = productData?.variants;
  if (!Array.isArray(variants) || !variants.length) return productData;
  const first = variants[0];
  const salePrice = Number(first.salePrice ?? first.price) || 0;
  const mrp = Number(first.price) || salePrice;
  productData.salePrice = salePrice;
  productData.price = mrp;
  productData.purchasePrice = Number(first.purchasePrice) || Number(productData.purchasePrice) || 0;
  if (first.unit) productData.unit = normalizeUnit(first.unit, productData.unit);
  productData.stock = totalVariantStock(variants);
  return productData;
}

/** Pricing slice from first variant for customer catalog cards. */
export function firstVariantPricing(product) {
  const variants = product?.variants || [];
  if (!variants.length) {
    const sale = Number(product?.salePrice ?? product?.price) || 0;
    const mrp = Number(product?.price) || sale;
    return { price: mrp, salePrice: sale, purchasePrice: Number(product?.purchasePrice) || 0, unit: product?.unit };
  }
  const first = variants[0];
  const mrp = Number(first.price) || 0;
  const sale = Number(first.salePrice ?? first.price) || mrp;
  return {
    price: mrp,
    salePrice: sale,
    purchasePrice: Number(first.purchasePrice ?? product?.purchasePrice) || 0,
    unit: first.unit || product?.unit,
  };
}

/** Customer-facing list/detail: card uses first variant; keeps all variants for picker. */
export function enrichCustomerProduct(item) {
  if (!item || typeof item !== "object") return item;
  const variants = Array.isArray(item.variants) ? item.variants : [];
  const first = firstVariantPricing(item);
  const sellPrices = variants
    .map((v) => Number(v.salePrice ?? v.price) || 0)
    .filter((n) => n > 0);
  const minSell = sellPrices.length ? Math.min(...sellPrices) : first.salePrice;
  const maxSell = sellPrices.length ? Math.max(...sellPrices) : first.salePrice;
  const multi = variants.length > 1;
  const variantLabel =
    multi && minSell !== maxSell
      ? `${variants.length} options · ₹${minSell} – ₹${maxSell}`
      : multi
        ? `${variants.length} options`
        : variants[0]?.name || null;

  return {
    ...item,
    variants,
    variantCount: variants.length,
    hasMultipleVariants: multi,
    displayPrice: minSell,
    displayPriceMax: maxSell,
    variantLabel,
    price: first.price,
    salePrice: minSell,
    purchasePrice: first.purchasePrice,
    unit: first.unit || item.unit,
    inStock: (Number(item.stock) || totalVariantStock(variants)) > 0,
  };
}

export function mapVariantsForResponse(variants = [], priceOverride = null) {
  return (variants || []).map((v) => {
    const row = typeof v?.toObject === "function" ? v.toObject() : { ...v };
    const stock = Number(row.stock);
    const price =
      priceOverride != null && priceOverride > 0
        ? priceOverride
        : Number(row.price) || 0;
    const salePrice =
      priceOverride != null && priceOverride > 0
        ? priceOverride
        : Number(row.salePrice ?? row.price) || 0;

    return {
      ...row,
      unit: normalizeUnit(row.unit),
      stock: Number.isFinite(stock) && stock >= 0 ? stock : 0,
      price,
      salePrice,
    };
  });
}

/** Seller listing mapped to an admin master catalog product. */
export function isSellerCatalogLinkedListing(product) {
  return product?.ownerType === "seller" && !!product?.masterProductId;
}

/**
 * Merge seller price/stock updates into an existing catalog-linked listing.
 * Variant names, units, and media stay tied to the master product.
 */
export function mergeSellerCatalogListingPricing(product, rawVariants, rootFields = {}) {
  const existingVariants = Array.isArray(product?.variants)
    ? product.variants.map((v) => (typeof v?.toObject === "function" ? v.toObject() : { ...v }))
    : [];
  const incoming = parseVariantsField(rawVariants);

  if (existingVariants.length === 0) {
    const iv = incoming[0] || {};
    const price =
      Number(iv.price ?? iv.salePrice ?? rootFields.price ?? product.price) || 0;
    const stock = Math.max(
      0,
      Number(iv.stock ?? rootFields.stock ?? product.stock) || 0,
    );
    if (price <= 0) {
      return { ok: false, message: "Supply price must be greater than 0" };
    }
    return {
      ok: true,
      data: {
        price,
        salePrice: price,
        purchasePrice: price,
        stock,
        variants: [],
      },
    };
  }

  if (incoming.length > 0 && incoming.length !== existingVariants.length) {
    return {
      ok: false,
      message:
        "Cannot add or remove variants on hub catalog products. Update supply price and stock only.",
    };
  }

  const merged = existingVariants.map((ev, idx) => {
    const iv =
      incoming[idx] ||
      incoming.find(
        (row) =>
          String(row?.name || "")
            .trim()
            .toLowerCase() === String(ev?.name || "").trim().toLowerCase(),
      ) ||
      {};
    const price = Number(iv.price ?? iv.salePrice);
    const resolvedPrice =
      Number.isFinite(price) && price > 0 ? price : Number(ev.price) || 0;
    const stock = Math.max(0, Number(iv.stock ?? ev.stock) || 0);
    return {
      ...ev,
      name: ev.name,
      unit: ev.unit,
      price: resolvedPrice,
      salePrice: resolvedPrice,
      purchasePrice: resolvedPrice,
      stock,
    };
  });

  const firstPrice = Number(merged[0]?.price) || Number(product.price) || 0;
  if (firstPrice <= 0) {
    return { ok: false, message: "Supply price must be greater than 0" };
  }

  return {
    ok: true,
    data: {
      price: firstPrice,
      salePrice: firstPrice,
      purchasePrice: firstPrice,
      stock: totalVariantStock(merged),
      variants: normalizeVariants(merged, {
        defaultUnit: product.unit,
        basePrice: firstPrice,
        baseSalePrice: firstPrice,
      }),
    },
  };
}

/** Restrict seller updates on hub-catalog listings to price and stock only. */
export function sanitizeSellerCatalogListingUpdate(product, productData, reqBody = {}) {
  const merged = mergeSellerCatalogListingPricing(
    product,
    productData.variants ?? reqBody.variants,
    {
      price: productData.price ?? reqBody.price,
      stock: productData.stock ?? reqBody.stock,
    },
  );
  if (!merged.ok) return merged;
  return { ok: true, data: merged.data };
}

/** Seller supply listing: procurement price + stock only (linked to a master catalog item). */
export function sanitizeSellerSupplyListingUpdate(product, productData, reqBody = {}) {
  if (isSellerCatalogLinkedListing(product) || product?.masterProductId) {
    return sanitizeSellerCatalogListingUpdate(product, productData, reqBody);
  }

  const supply = Number(productData.price ?? reqBody.price ?? productData.salePrice);
  const stock = Math.max(0, Number(productData.stock ?? reqBody.stock ?? product.stock) || 0);

  if (Number.isFinite(supply) && supply > 0) {
    return {
      ok: true,
      data: {
        price: supply,
        salePrice: supply,
        purchasePrice: supply,
        stock,
      },
    };
  }

  if (productData.stock !== undefined || reqBody.stock !== undefined) {
    return { ok: true, data: { stock } };
  }

  return {
    ok: false,
    message: "Sellers can only update supply price and stock on live listings.",
  };
}

/**
 * Pending seller-owned submission (no master yet): allow descriptive fields,
 * but customer MRP / selling price / images on master are admin-only after go-live.
 */
export function sanitizeSellerPendingSubmissionUpdate(product, productData, reqBody = {}) {
  const allowed = {};
  const textKeys = ["name", "description", "brand", "weight", "categoryId", "subcategoryId", "unit", "tags"];
  for (const key of textKeys) {
    if (productData[key] !== undefined) allowed[key] = productData[key];
  }

  if (productData.lowStockAlert !== undefined) {
    allowed.lowStockAlert = productData.lowStockAlert;
  }

  const supply = Number(productData.price ?? reqBody.price ?? productData.salePrice);
  if (Number.isFinite(supply) && supply > 0) {
    allowed.price = supply;
    allowed.salePrice = supply;
    allowed.purchasePrice = supply;
  }

  if (productData.stock !== undefined || reqBody.stock !== undefined) {
    allowed.stock = Math.max(0, Number(productData.stock ?? reqBody.stock) || 0);
  }

  if (productData.variants !== undefined || reqBody.variants !== undefined) {
    const raw = parseVariantsField(productData.variants ?? reqBody.variants);
    if (raw.length > 0) {
      const baseSupply = Number.isFinite(supply) && supply > 0 ? supply : Number(product.price) || 0;
      allowed.variants = normalizeVariants(raw, {
        defaultUnit: allowed.unit || product.unit,
        basePrice: baseSupply,
        baseSalePrice: baseSupply,
      }).map((v) => ({
        ...v,
        price: Number(v.price) > 0 ? v.price : baseSupply,
        salePrice: Number(v.salePrice) > 0 ? v.salePrice : baseSupply,
        purchasePrice: Number(v.purchasePrice) > 0 ? v.purchasePrice : baseSupply,
      }));
      allowed.stock = totalVariantStock(allowed.variants);
    }
  }

  return { ok: true, data: allowed, allowImages: true };
}

/** Route seller updates: catalog-linked / live = supply only; pending = submission fields. */
export function sanitizeSellerProductUpdate(product, productData, reqBody = {}) {
  const isPendingOwn =
    product?.ownerType === "seller" &&
    !product?.masterProductId &&
    String(product?.status || "") === "pending_approval";

  if (isPendingOwn) {
    return sanitizeSellerPendingSubmissionUpdate(product, productData, reqBody);
  }

  return sanitizeSellerSupplyListingUpdate(product, productData, reqBody);
}

/** Copy master catalog presentation fields onto a seller listing payload. */
export function inheritMasterCatalogFields(productData, master) {
  if (!master) return productData;
  productData.name = master.name;
  productData.description = master.description || "";
  productData.brand = master.brand || "";
  productData.weight = master.weight || "";
  productData.unit = master.unit || productData.unit;
  productData.categoryId = master.categoryId;
  productData.subcategoryId = master.subcategoryId;
  productData.mainImage = master.mainImage || null;
  productData.galleryImages = Array.isArray(master.galleryImages) ? master.galleryImages : [];
  return productData;
}
