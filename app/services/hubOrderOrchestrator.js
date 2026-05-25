import HubInventory from "../models/hubInventory.js";
import Product from "../models/product.js";
import PurchaseRequest from "../models/purchaseRequest.js";
import { effectiveProductStock } from "../utils/productHelpers.js";

const HUB_ID = process.env.DEFAULT_HUB_ID || "MAIN_HUB";
const DEFAULT_PROCUREMENT_MARGIN_TYPE = String(
  process.env.DEFAULT_PROCUREMENT_MARGIN_TYPE || "percent",
).toLowerCase() === "flat"
  ? "flat"
  : "percent";
const DEFAULT_PROCUREMENT_MARGIN_VALUE = Math.max(
  0,
  Number(process.env.DEFAULT_PROCUREMENT_MARGIN_VALUE || 15),
);

const buildRequestId = () =>
  `PR-${Date.now()}-${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;

export const HUB_ORDER_MODE = () =>
  String(process.env.HUB_FIRST_ORDER_ROUTING || "false").toLowerCase() === "true";

/**
 * Build stock snapshot and shortages for an order's items.
 */
export const planHubFulfillment = async (orderItems, hubId = HUB_ID) => {
  const productIds = orderItems.map((item) => String(item.product));
  const [inventoryRows, products] = await Promise.all([
    HubInventory.find({ hubId, productId: { $in: productIds } }).lean(),
    Product.find({ _id: { $in: productIds } })
      .select("_id sellerId name categoryId subcategoryId ownerType price salePrice purchasePrice stock variants")
      .lean(),
  ]);

  const invMap = new Map(
    inventoryRows.map((row) => [String(row.productId), Number(row.availableQty || 0)]),
  );
  const sellerMap = new Map(
    products.map((p) => [String(p._id), p?.sellerId ? String(p.sellerId) : null]),
  );
  const productMap = new Map(products.map((p) => [String(p._id), p]));

  const shortages = [];
  const allocations = [];

  for (const item of orderItems) {
    const productId = String(item.product);
    const requiredQty = Number(item.quantity || 0);
    const availableQty = Math.max(0, Number(invMap.get(productId) || 0));
    const reserveQty = Math.min(availableQty, requiredQty);
    const shortageQty = Math.max(0, requiredQty - reserveQty);
    allocations.push({ productId, reserveQty });
    if (shortageQty > 0) {
      shortages.push({
        productId,
        requiredQty,
        availableQtyAtHub: availableQty,
        shortageQty,
        vendorId: sellerMap.get(productId) || null,
        baseProduct: productMap.get(productId) || null,
      });
    }
  }

  return {
    hubId,
    allocations,
    shortages,
    fullyAvailable: shortages.length === 0,
  };
};

/**
 * Reserve inventory rows for fully-available orders.
 * Returns false if any reserve check fails (race-safe).
 */
export const reserveHubInventory = async (allocations, hubId = HUB_ID) => {
  const reservedRows = [];
  for (const row of allocations) {
    if (!row.reserveQty || row.reserveQty <= 0) continue;
    const updated = await HubInventory.findOneAndUpdate(
      {
        hubId,
        productId: row.productId,
        availableQty: { $gte: row.reserveQty },
      },
      {
        $inc: {
          availableQty: -row.reserveQty,
          reservedQty: row.reserveQty,
        },
      },
      { new: true },
    );
    
    if (updated) {
      // Keep Product root stock in sync for Admin view consistency
      await Product.findByIdAndUpdate(row.productId, {
        $inc: { stock: -row.reserveQty }
      });
    }
    if (!updated) {
      // Roll back partial reservations when any line fails (race-safe best effort).
      for (const applied of reservedRows) {
        await HubInventory.findOneAndUpdate(
          { hubId, productId: applied.productId },
          {
            $inc: {
              availableQty: applied.reserveQty,
              reservedQty: -applied.reserveQty,
            },
          },
        );
      }
      return { ok: false, reservedRows: [] };
    }
    reservedRows.push({ productId: row.productId, reserveQty: row.reserveQty });
  }
  return { ok: true, reservedRows };
};

/**
 * Create procurement requests grouped by vendor for shortage items.
 */
export const createAutoPurchaseRequests = async ({
  order,
  shortages,
  hubId = HUB_ID,
  allowUnassigned = false,
}) => {
  const normalizeMoney = (value) => Math.max(0, Number(Number(value || 0).toFixed(2)));
  const effectiveCatalogPrice = (row) => {
    // Priority 1: Use purchasePrice if available (this is the true vendor cost/procurement rate)
    const cost = Number(row?.purchasePrice || 0);
    if (cost > 0) return cost;

    // Fallback: Use salePrice or base price
    const sale = Number(row?.salePrice || 0);
    const base = Number(row?.price || 0);
    return sale > 0 && sale < base ? sale : base;
  };
  const normalizeText = (value) =>
    String(value || "")
      .trim()
      .toLowerCase();
  const sameCategory = (candidate, base) =>
    String(candidate?.categoryId || "") === String(base?.categoryId || "") &&
    String(candidate?.subcategoryId || "") === String(base?.subcategoryId || "");

  const selectCheapestSellers = async (baseProduct, shortageQty) => {
    if (!baseProduct) return [];
    const totalNeeded = Math.max(1, Number(shortageQty || 0));
    const matchOr = [];
    if (String(baseProduct.name || "").trim()) {
      matchOr.push({ name: String(baseProduct.name).trim() });
    }
    if (baseProduct.categoryId && baseProduct.subcategoryId) {
      matchOr.push({
        categoryId: baseProduct.categoryId,
        subcategoryId: baseProduct.subcategoryId,
      });
    }
    if (!matchOr.length) return [];

    const candidates = await Product.find({
      ownerType: "seller",
      status: "active",
      sellerId: { $ne: null },
      $or: matchOr,
    })
      .select("_id sellerId stock name categoryId subcategoryId price salePrice purchasePrice variants")
      .lean();

    const inStock = candidates.filter((row) => effectiveProductStock(row) > 0);
    if (!inStock.length) return [];

    const scored = inStock.map((row) => {
      const unitCost = normalizeMoney(effectiveCatalogPrice(row));
      const available = effectiveProductStock(row);
      const nameMatch =
        normalizeText(row.name) &&
        normalizeText(row.name) === normalizeText(baseProduct.name);
      const categoryMatch = sameCategory(row, baseProduct);
      let qualityRank = 4;
      if (nameMatch && categoryMatch) qualityRank = 1;
      else if (nameMatch) qualityRank = 2;
      else if (categoryMatch) qualityRank = 3;
      return {
        ...row,
        unitCost,
        qualityRank,
        availableStock: available,
      };
    });

    scored.sort((a, b) => {
      if (a.qualityRank !== b.qualityRank) return a.qualityRank - b.qualityRank;
      if (a.unitCost !== b.unitCost) return a.unitCost - b.unitCost;
      return Number(b.availableStock || 0) - Number(a.availableStock || 0);
    });

    const results = [];
    let remaining = totalNeeded;
    for (const vendor of scored) {
      if (remaining <= 0) break;
      const canTake = Math.min(remaining, Number(vendor.availableStock || 0));
      if (canTake <= 0) continue;

      results.push({
        vendorId: vendor.sellerId ? String(vendor.sellerId) : null,
        selectedSellerProductId: vendor._id ? String(vendor._id) : null,
        qtyToProcure: canTake,
        vendorUnitCost: vendor.unitCost,
        vendorQuotedPrice: normalizeMoney(effectiveCatalogPrice(vendor)),
        pricingStrategy:
          vendor.qualityRank === 1
            ? "cheapest_name_category_match"
            : vendor.qualityRank === 2
              ? "cheapest_name_match"
              : "cheapest_category_match",
        gstRate: 0,
      });
      remaining -= canTake;
    }
    return results;
  };

  const shortageProductIds = shortages
    .map((item) => String(item.productId || ""))
    .filter(Boolean);

  const fallbackProducts = shortageProductIds.length
    ? await Product.find({ _id: { $in: shortageProductIds } })
        .select(
          "_id sellerId name categoryId subcategoryId ownerType stock price salePrice purchasePrice variants",
        )
        .lean()
    : [];
  const fallbackProductMap = new Map(fallbackProducts.map((p) => [String(p._id), p]));

  const enrichedShortages = [];
  for (const item of shortages) {
    const productId = String(item.productId || "");
    const baseProduct = item.baseProduct || fallbackProductMap.get(productId) || null;

    if (item.vendorId && Number(baseProduct?.stock || 0) >= Number(item.shortageQty || 0)) {
      const selfCost = normalizeMoney(effectiveCatalogPrice(baseProduct));
      enrichedShortages.push({
        ...item,
        vendorId: String(item.vendorId),
        selectedSellerProductId: baseProduct?.ownerType === "seller" ? String(baseProduct?._id || "") : null,
        vendorUnitCost: selfCost,
        vendorQuotedPrice: selfCost,
        pricingStrategy: "direct_vendor_mapping",
        gstRate: 0,
        gstAmount: 0,
        marginType: DEFAULT_PROCUREMENT_MARGIN_TYPE,
        marginValue: DEFAULT_PROCUREMENT_MARGIN_VALUE,
      });
    } else {
      // eslint-disable-next-line no-await-in-loop
      const selections = await selectCheapestSellers(baseProduct, item.shortageQty);
      if (selections.length === 0) {
        enrichedShortages.push({
          ...item,
          vendorId: null,
          selectedSellerProductId: null,
          vendorUnitCost: normalizeMoney(effectiveCatalogPrice(baseProduct)),
          vendorQuotedPrice: normalizeMoney(effectiveCatalogPrice(baseProduct)),
          pricingStrategy: "fallback_catalog_price",
          gstRate: 0,
          gstAmount: 0,
          marginType: DEFAULT_PROCUREMENT_MARGIN_TYPE,
          marginValue: DEFAULT_PROCUREMENT_MARGIN_VALUE,
        });
      } else {
        for (const sel of selections) {
          enrichedShortages.push({
            ...item,
            shortageQty: sel.qtyToProcure,
            vendorId: sel.vendorId,
            selectedSellerProductId: sel.selectedSellerProductId,
            vendorUnitCost: sel.vendorUnitCost,
            vendorQuotedPrice: sel.vendorQuotedPrice,
            pricingStrategy: sel.pricingStrategy,
            gstRate: 0,
            gstAmount: 0,
            marginType: DEFAULT_PROCUREMENT_MARGIN_TYPE,
            marginValue: DEFAULT_PROCUREMENT_MARGIN_VALUE,
          });
        }
      }
    }
  }

  const unassigned = enrichedShortages.filter((row) => !row.vendorId);
  if (unassigned.length > 0 && !allowUnassigned) {
    const names = unassigned
      .map((u) => u?.baseProduct?.name || u?.productId)
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
    const suffix = unassigned.length > 3 ? "..." : "";
    throw new Error(
      `Some items are out of stock and cannot be procured right now: ${names}${suffix}`,
    );
  }

  const grouped = new Map();
  for (const item of enrichedShortages.filter((row) => row.vendorId)) {
    const groupKey = item.vendorId || "UNASSIGNED";
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(item);
  }

  const docs = [];
  for (const [vendorKey, items] of grouped.entries()) {
    const vendorId = vendorKey === "UNASSIGNED" ? null : vendorKey;
    docs.push({
      requestId: buildRequestId(),
      orderId: order._id,
      hubId,
      vendorId,
      status: "created",
      items: items.map((i) => ({
        productId: i.productId,
        requiredQty: i.requiredQty,
        availableQtyAtHub: i.availableQtyAtHub,
        shortageQty: i.shortageQty,
        committedQty: 0,
        selectedSellerProductId: i.selectedSellerProductId || undefined,
        vendorUnitCost: i.vendorUnitCost || 0,
        vendorQuotedPrice: i.vendorQuotedPrice || 0,
        pricingStrategy: i.pricingStrategy || "",
        gstRate: i.gstRate || 0,
        gstAmount: i.gstAmount || 0,
      })),
      notes:
        vendorId === null
          ? `Auto-generated from order ${order.orderId} (vendor assignment required)`
          : `Auto-generated from order ${order.orderId}`,
    });
  }

  if (!docs.length) return [];
  return PurchaseRequest.insertMany(docs);
};
