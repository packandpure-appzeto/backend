import mongoose from "mongoose";
import Product from "../models/product.js";
import HubInventory from "../models/hubInventory.js";
import Admin from "../models/admin.js";
import Notification from "../models/notification.js";
import Seller from "../models/seller.js";
import { handleResponse } from "../utils/helper.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
import getPagination from "../utils/pagination.js";
import { ensureUniqueSlug, duplicateKeyMessage } from "../utils/productSlug.js";
import {
  normalizeUnit,
  parseVariantsField,
  normalizeVariants,
  totalVariantStock,
  catalogStockFromProduct,
  hubQtyFromInventoryRow,
  enrichCustomerProduct,
  effectiveSellingPrice,
  syncRootFromFirstVariant,
  pickWritableProductFields,
  stripDeprecatedProductFields,
  mapVariantsForResponse,
  normalizeProductBodyFields,
  listVariantsForStockPicker,
  resolveVariantIndex,
  setVariantStockAtIndex,
  variantStockRequiresSelection,
} from "../utils/productHelpers.js";
import {
  parseCustomerCoordinates,
  getNearbySellerIdsForCustomer,
} from "../services/customerVisibilityService.js";

function isCustomerVisibilityRequest(req) {
  // If explicitly searching master catalog, it's not a location-bound customer request
  if (req.query.ownerType === "admin") return false;
  
  const role = String(req.user?.role || "").toLowerCase();
  return !role || role === "customer" || role === "user";
}

function parseSellerIdFilters({ sellerId, sellerIds }) {
  if (typeof sellerIds === "string" && sellerIds.trim()) {
    return sellerIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map(String);
  }

  if (sellerId) {
    return [String(sellerId)];
  }

  return [];
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

const DEFAULT_HUB_ID = process.env.DEFAULT_HUB_ID || "MAIN_HUB";

function hubInventoryStatus(availableQty, reorderLevel = 10) {
  const qty = Math.max(0, Number(availableQty) || 0);
  const reorder = Math.max(0, Number(reorderLevel) || 0);
  if (qty <= 0) return "out_of_stock";
  if (qty <= reorder) return "low_stock";
  return "healthy";
}

/** Admin master: variant stock in the form is hub warehouse qty. */
async function syncAdminHubStock(productId, quantity, opts = {}) {
  const qty = Math.max(0, Number(quantity) || 0);
  const reorderLevel = Math.max(0, Number(opts.reorderLevel ?? 10));
  const sellPrice = Number(opts.sellPrice ?? 0);
  const setFields = {
    availableQty: qty,
    status: hubInventoryStatus(qty, reorderLevel),
    reorderLevel,
  };
  if (sellPrice > 0) {
    setFields.sellPrice = sellPrice;
    setFields.priceUpdatedAt = new Date();
  }

  await HubInventory.findOneAndUpdate(
    { hubId: DEFAULT_HUB_ID, productId },
    {
      $set: setFields,
      $setOnInsert: { reservedQty: 0 },
    },
    { upsert: true, new: true },
  );
}

function applyVariantsToProductData(productData) {
  const defaultUnit = normalizeUnit(productData.unit);
  productData.unit = defaultUnit;

  const rawVariants = parseVariantsField(productData.variants);
  if (rawVariants.length > 0) {
    const basePrice = Number(productData.price) || 0;
    const baseSale = Number(productData.salePrice) || basePrice;
    productData.variants = normalizeVariants(rawVariants, {
      defaultUnit,
      basePrice,
      baseSalePrice: baseSale,
    });
    syncRootFromFirstVariant(productData);
  } else {
    productData.variants = [];
    productData.stock = Math.max(0, Number(productData.stock) || 0);
  }
}

/* ===============================
   GET ALL PRODUCTS (Public/Admin)
 ================================ */
export const getProducts = async (req, res) => {
  try {
    const {
      search,
      category,
      subcategory,
      status,
      sellerId,
      featured,
      ownerType,
      categoryId,
      subcategoryId,
      categoryIds,
      sellerIds,
      lat,
      lng,
    } = req.query;
    const enforceHubOnly = isCustomerVisibilityRequest(req);
    const requestRole = String(req.user?.role || "").toLowerCase();
    const isAdminCatalogRequest =
      requestRole === "admin" ||
      String(req.originalUrl || req.url || "").includes("/admin/list");

    const query = {};
    
    if (ownerType) query.ownerType = ownerType;
    if (status) query.status = status;
    if (sellerId) query.sellerId = sellerId;

    // Quick Filters based on stock status
    if (req.query.stockStatus === 'active') {
      query.status = 'active';
    } else if (req.query.stockStatus === 'low_stock') {
      query.stock = { $gt: 0, $lte: 10 };
    } else if (req.query.stockStatus === 'out_of_stock') {
      query.stock = 0;
    }

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { brand: { $regex: search, $options: "i" } },
        { tags: { $in: [new RegExp(search, "i")] } }
      ];
    }

    const finalCategoryId = category || categoryId;
    const finalSubcategoryId = subcategory || subcategoryId;

    if (finalCategoryId) query.categoryId = finalCategoryId;
    if (finalSubcategoryId) query.subcategoryId = finalSubcategoryId;

    if (enforceHubOnly) {
      const coords = parseCustomerCoordinates({ lat, lng });
      if (!coords.valid) {
        return handleResponse(res, 400, "lat and lng are required for customer product visibility");
      }
      
      const hubId = process.env.DEFAULT_HUB_ID || "MAIN_HUB";
      const [hubRows, sellerMasterIds] = await Promise.all([
        HubInventory.find({ hubId, availableQty: { $gt: 0 } })
          .select("productId")
          .lean(),
        Product.distinct("masterProductId", {
          ownerType: "seller",
          status: "active",
          stock: { $gt: 0 },
          masterProductId: { $ne: null },
        }),
      ]);

      const eligibleIds = Array.from(
        new Set([
          ...(hubRows || []).map((row) => row?.productId && String(row.productId)).filter(Boolean),
          ...(sellerMasterIds || []).map((id) => id && String(id)).filter(Boolean),
        ]),
      );

      query.ownerType = "admin";
      query.status = "active";
      query._id = { $in: eligibleIds };
    } else {
      if (status) query.status = status;
      if (req.query.ownerType === "admin") {
        query.ownerType = "admin";
      } else {
        if (sellerId) query.sellerId = sellerId;
        if (req.query.ownerType) query.ownerType = req.query.ownerType;
      }
    }

    if (enforceHubOnly) {
      query.status = "active";
    } else if (!status && !req.user?.role) {
      query.status = "active";
    } else if (status) {
      query.status = status;
    }

    // Multiple categories: categoryIds=id1,id2
    if (categoryIds && typeof categoryIds === "string") {
      const ids = categoryIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (ids.length) query.categoryId = { $in: ids };
    }
    // Multiple sellers: sellerIds=id1,id2 (or single sellerId)
    if (!query.sellerId) {
      if (sellerIds && typeof sellerIds === "string") {
        const ids = sellerIds
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean);
        if (ids.length) query.sellerId = { $in: ids };
      } else if (sellerId) {
        query.sellerId = sellerId;
      }
    }

    if (featured !== undefined) query.isFeatured = featured === "true";

    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 24,
      maxLimit: 100,
    });

    const products = await Product.find(query)
      .select(
        "name slug description price salePrice purchasePrice stock brand weight unit mainImage galleryImages categoryId subcategoryId sellerId ownerType status isFeatured variants createdAt",
      )
      .populate("categoryId", "name")
      .populate("subcategoryId", "name")
      .populate("sellerId", "shopName")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const masterProductIds = [
      ...products.map((p) => p._id),
      ...products.map((p) => p.masterProductId).filter(Boolean),
    ];
    const hubRowsForResult = await HubInventory.find({
      productId: { $in: masterProductIds },
      hubId: DEFAULT_HUB_ID,
    }).lean();

    const hubMap = new Map();
    hubRowsForResult.forEach((r) => {
      if (r.productId) {
        hubMap.set(String(r.productId), hubQtyFromInventoryRow(r));
      }
    });

    const productIdsForAgg = products.map((p) => String(p._id)).filter(id => mongoose.Types.ObjectId.isValid(id));
    
    let sellerStockMap = new Map();
    if (productIdsForAgg.length > 0) {
      try {
        const sellerStockSummary = await Product.aggregate([
          {
            $match: {
              masterProductId: { $in: productIdsForAgg.map(id => new mongoose.Types.ObjectId(id)) },
              ownerType: "seller",
              status: "active",
            },
          },
          {
            $group: {
              _id: "$masterProductId",
              totalSellerStock: {
                $sum: {
                  $cond: {
                    if: { $and: [{ $isArray: "$variants" }, { $gt: [{ $size: "$variants" }, 0] }] },
                    then: {
                      $reduce: {
                        input: "$variants",
                        initialValue: 0,
                        in: { $add: ["$$value", { $ifNull: ["$$this.stock", 0] }] }
                      }
                    },
                    else: { $ifNull: ["$stock", 0] }
                  }
                }
              },
              minPurchasePrice: { $min: "$purchasePrice" },
              avgPurchasePrice: { $avg: "$purchasePrice" }
            },
          },
        ]);
        sellerStockSummary.forEach(s => {
          if (s._id) {
            sellerStockMap.set(String(s._id), {
              stock: Number(s.totalSellerStock || 0),
              cost: Number(s.minPurchasePrice || s.avgPurchasePrice || 0)
            });
          }
        });
      } catch (err) {
        console.error("[getProducts] Aggregation Error:", err.message);
      }
    }

    const masterIds = products.map(p => p.masterProductId).filter(Boolean);
    const masterProducts = masterIds.length > 0 ? await Product.find({ _id: { $in: masterIds } }).select('price salePrice').lean() : [];

    const productsWithSource = products.map((p) => {
      const pIdStr = String(p._id);
      const hubQty = hubMap.get(pIdStr) ?? 0;

      if (p.ownerType === "admin") {
        const mappedSellerData = sellerStockMap.get(pIdStr) || { stock: 0, cost: p.purchasePrice || 0 };
        const mappedSellerStock = mappedSellerData.stock;
        const fulfillableQty = hubQty + mappedSellerStock;
        const hubRow = hubRowsForResult.find((r) => String(r.productId) === pIdStr);
        const dynamicPrice =
          hubRow?.sellPrice && hubRow.sellPrice > 0 ? hubRow.sellPrice : p.salePrice || p.price;
        const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;

        return {
          ...p,
          price: hasVariants ? p.price : dynamicPrice,
          salePrice: hasVariants ? p.salePrice || p.price : dynamicPrice,
          purchasePrice: mappedSellerData.cost,
          stock: hubQty,
          catalogStock: hubQty,
          availableQtyHub: hubQty,
          availableQtySeller: mappedSellerStock,
          totalAvailableQty: fulfillableQty,
          totalFulfillmentQty: fulfillableQty,
          variants: mapVariantsForResponse(p.variants),
          fulfillmentSource:
            hubQty > 0 ? "hub" : mappedSellerStock > 0 ? "procure" : "out_of_stock",
        };
      }

      const masterProduct = masterProducts.find(
        (m) => String(m._id) === String(p.masterProductId),
      );
      const customerPrice = masterProduct
        ? masterProduct.salePrice || masterProduct.price
        : p.salePrice || p.price;
      const sellerListingStock = catalogStockFromProduct(p);
      const hubQtyForSeller = p.masterProductId
        ? hubMap.get(String(p.masterProductId)) ?? 0
        : 0;

      return {
        ...p,
        price: customerPrice || p.price,
        salePrice: customerPrice || p.salePrice,
        availableQtyHub: hubQtyForSeller,
        availableQtySeller: sellerListingStock,
        stock: sellerListingStock,
        catalogStock: sellerListingStock,
        sellerListingStock,
        totalAvailableQty: sellerListingStock,
        variants: mapVariantsForResponse(p.variants),
        fulfillmentSource: sellerListingStock > 0 ? "direct" : "out_of_stock",
      };
    });

    const statsQuery = { ...query };
    delete statsQuery.status;
    delete statsQuery.stock;
    if (query.ownerType) statsQuery.ownerType = query.ownerType;

    const [total, activeCount, lowStockCount, outOfStockCount] = await Promise.all([
      Product.countDocuments(statsQuery),
      Product.countDocuments({ ...statsQuery, status: 'active' }),
      Product.countDocuments({ ...statsQuery, stock: { $gt: 0, $lte: 10 } }),
      Product.countDocuments({ ...statsQuery, stock: 0 }),
    ]);

    const items = isAdminCatalogRequest
      ? productsWithSource
      : productsWithSource.map((row) => enrichCustomerProduct(row));

    return handleResponse(res, 200, "Products fetched successfully", {
      items,
      page,
      limit,
      total,
      stats: {
        total,
        active: activeCount,
        lowStock: lowStockCount,
        outOfStock: outOfStockCount,
      },
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET SELLER PRODUCTS
 ================================ */
export const getSellerProducts = async (req, res) => {
  try {
    const sellerId = req.user.id;
    const { stockStatus } = req.query;
    const { page, limit, skip } = getPagination(req, {
      defaultLimit: 20,
      maxLimit: 100,
    });

    const query = { sellerId };
    if (stockStatus === "in") {
      query.stock = { $gt: 0 };
    } else if (stockStatus === "out") {
      query.stock = 0;
    }

    const results = await Product.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate("sellerId", "shopName name")
      .populate("categoryId", "name")
      .populate("subcategoryId", "name")
      .populate({
        path: "masterProductId",
        select: "name slug price salePrice stock variants unit",
      })
      .lean();

    // DYNAMIC STOCK SYNC: If master product, sum Hub + Seller stocks
    const finalItems = await Promise.all(results.map(async (p) => {
      if (p.ownerType === 'admin') {
        const hRows = await HubInventory.find({ productId: p._id }).lean();
        const sRows = await Product.find({ masterProductId: p._id, ownerType: 'seller', status: 'active' }).select('stock').lean();
        const hQty = hRows.reduce((s, r) => s + Number(r.hubStockQuantity || 0), 0);
        const sQty = sRows.reduce((s, r) => s + Number(r.stock || 0), 0);
        return { ...p, stock: hQty + sQty, hQty, sQty };
      }
      return p;
    }));

    const total = await Product.countDocuments(query);

    return handleResponse(res, 200, "Products fetched successfully", {
      items: finalItems,
      page: Number(page),
      limit: Number(limit),
      total,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   CREATE PRODUCT
 ================================ */
export const createProduct = async (req, res) => {
  try {
    const productData = pickWritableProductFields(req.body);
    stripDeprecatedProductFields(productData);
    normalizeProductBodyFields(productData);
    const role = String(req.user?.role || "").toLowerCase();

    if (!String(productData.name || "").trim()) {
      return handleResponse(res, 400, "Product name is required");
    }
    if (
      !productData.categoryId ||
      !mongoose.Types.ObjectId.isValid(String(productData.categoryId))
    ) {
      return handleResponse(res, 400, "Valid parent category is required");
    }
    if (
      !productData.subcategoryId ||
      !mongoose.Types.ObjectId.isValid(String(productData.subcategoryId))
    ) {
      return handleResponse(res, 400, "Valid subcategory is required");
    }

    if (role === "admin") {
      productData.ownerType = "admin";
      productData.sellerId = null;
      productData.status = productData.status || "active";
    } else {
      productData.ownerType = "seller";
      productData.sellerId = req.user.id;
      productData.status = "pending_approval";

      // HUB-FIRST SOP: Seller price represents procurement/supply cost for Hub.
      // Normalize seller pricing so `price`, `salePrice`, and `purchasePrice` stay consistent.
      if (productData.price !== undefined) {
        const supply = Number(productData.price);
        if (Number.isFinite(supply)) {
          productData.price = supply;
          productData.salePrice = supply;
          productData.purchasePrice = supply;
        }
      }
    }

    if (req.files) {
      if (req.files.mainImage && req.files.mainImage[0]) {
        productData.mainImage = await uploadToCloudinary(req.files.mainImage[0].buffer, "products");
      }
      if (req.files.galleryImages && req.files.galleryImages.length > 0) {
        const uploadPromises = req.files.galleryImages.map((file) => uploadToCloudinary(file.buffer, "products"));
        productData.galleryImages = await Promise.all(uploadPromises);
      }
    }

    applyVariantsToProductData(productData);

    if (effectiveSellingPrice(productData) <= 0) {
      return handleResponse(res, 400, "Selling price (salePrice) must be greater than 0");
    }

    // If seller is creating, their price is the purchasePrice for the admin
    if (role !== "admin") {
      productData.purchasePrice = productData.price || 0;
    } else if (productData.purchasePrice === undefined) {
      productData.purchasePrice = 0;
    }

    // Standardize masterProductId (remove empty strings which cause BSON errors)
    if (productData.masterProductId === "" || productData.masterProductId === "null" || !productData.masterProductId) {
      delete productData.masterProductId;
    }

    // --- HUB-FIRST CATALOG MAPPING (Only for Sellers) ---
    if (role !== "admin") {
      if (!productData.masterProductId) {
        const normalizedName = String(productData.name || "").trim();
        // Check if an EXACT master product already exists to auto-link
        const existingMaster = await Product.findOne({
          name: { $regex: new RegExp(`^${normalizedName}$`, "i") },
          ownerType: "admin"
        });

        if (existingMaster) {
          productData.masterProductId = existingMaster._id;
          if (!productData.categoryId) productData.categoryId = existingMaster.categoryId;
          if (!productData.subcategoryId) productData.subcategoryId = existingMaster.subcategoryId;
          if (!productData.unit) productData.unit = existingMaster.unit;
        } else {
          // IMPORTANT: We NO LONGER auto-create a master product here.
          // The item stays as masterProductId: null until Admin maps it during approval.
          productData.masterProductId = null;
        }
      }

      // Seller-Specific Duplicate Check
      if (productData.masterProductId) {
        const alreadyExists = await Product.findOne({
          sellerId: req.user.id,
          masterProductId: productData.masterProductId
        });
        if (alreadyExists) {
          return handleResponse(res, 400, "You have already listed this product.");
        }
      }
    }

    delete productData.slug;

    let product;
    for (let attempt = 0; attempt < 5; attempt++) {
      productData.slug = await ensureUniqueSlug(productData.name);
      try {
        product = new Product(productData);
        await product.save();
        break;
      } catch (saveErr) {
        if (saveErr?.code === 11000 && saveErr?.keyPattern?.slug && attempt < 4) {
          delete productData.slug;
          continue;
        }
        throw saveErr;
      }
    }

    // --- NOTIFY ADMINS IF SELLER CREATED PRODUCT ---
    if (product.ownerType === "seller") {
        try {
            const seller = await Seller.findById(product.sellerId).select('shopName name');
            const vendorName = seller ? (seller.shopName || seller.name) : 'Unknown Vendor';
            const admins = await Admin.find({}, '_id');
            const notifications = admins.map(admin => ({
                recipient: admin._id,
                recipientModel: 'Admin',
                title: 'New Product Added',
                message: `New Product Added: ${product.name} by Vendor: ${vendorName}.`,
                type: 'system',
                data: { productId: product._id, sellerId: product.sellerId }
            }));
            if (notifications.length > 0) {
                await Notification.insertMany(notifications);
            }
        } catch (notifErr) {
            console.error("Error creating admin notification for new product:", notifErr);
        }
    }
    // -----------------------------------------------

    // Ensure Admin products have an entry in Hub Inventory
    if (product.ownerType === "admin") {
      try {
        // We initialize with 0! Stock should come from Hub Inventory management or Seller procurement.
        const seededSellPrice = Number(productData.salePrice || 0) > 0
          ? Number(productData.salePrice)
          : Number(productData.price || 0);

        const hubQty = totalVariantStock(product.variants) || Math.max(0, Number(product.stock) || 0);
        await syncAdminHubStock(product._id, hubQty, {
          sellPrice: seededSellPrice,
          reorderLevel: Number(productData.lowStockAlert || 10),
        });
      } catch (err) {
        console.warn("[createProduct] Hub entry sync failed", err.message);
      }
    }

    return handleResponse(res, 201, "Product created successfully", product);
  } catch (error) {
    const dupMsg = duplicateKeyMessage(error);
    if (dupMsg) return handleResponse(res, 400, dupMsg);
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE PRODUCT
 ================================ */
export const updateProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const sellerId = req.user.id;
    const role = String(req.user?.role || "").toLowerCase();
    const productData = pickWritableProductFields(req.body);
    stripDeprecatedProductFields(productData);
    normalizeProductBodyFields(productData);
    delete productData.ownerType;

    // Admin bypasses sellerId check
    const query = role === "admin" ? { _id: id } : { _id: id, sellerId };
    const product = await Product.findOne(query);

    if (!product) {
      return handleResponse(res, 404, "Product not found or unauthorized");
    }

    // Optional: allow seller to keep/remove existing gallery images during update
    let keepGalleryImages;
    if (productData.keepGalleryImages !== undefined) {
      try {
        const parsed = typeof productData.keepGalleryImages === "string"
          ? JSON.parse(productData.keepGalleryImages)
          : productData.keepGalleryImages;
        if (Array.isArray(parsed)) {
          keepGalleryImages = parsed.filter((u) => typeof u === "string" && u.trim()).map((u) => u.trim());
        }
      } catch (e) {
        // ignore parse error
      }
      delete productData.keepGalleryImages;
    }

    if (role === "admin" && product.ownerType === "seller") {
      let parsedVars = [];
      if (typeof productData.variants === "string") {
        try {
          parsedVars = JSON.parse(productData.variants);
        } catch (e) {}
      } else if (Array.isArray(productData.variants)) {
        parsedVars = productData.variants;
      }

      const sellPrice = Number(productData.customerPrice || productData.price || productData.salePrice);
      if (product.masterProductId) {
        const masterUpdate = {};
        if (sellPrice > 0) {
          masterUpdate.price = sellPrice;
          masterUpdate.salePrice = sellPrice;
        }
        if (parsedVars && parsedVars.length > 0) {
          masterUpdate.variants = normalizeVariants(parsedVars, {
            defaultUnit: product.unit,
            basePrice: sellPrice,
            baseSalePrice: sellPrice,
          });
        }
        if (Object.keys(masterUpdate).length > 0) {
          await Product.findByIdAndUpdate(product.masterProductId, { $set: masterUpdate });
          if (sellPrice > 0) {
            await mongoose.model("HubInventory").updateMany({ productId: product.masterProductId }, { $set: { sellPrice: sellPrice } });
          }
        }
      } else if (sellPrice > 0) {
        let existingMaster = await Product.findOne({
          name: { $regex: new RegExp(`^${String(product.name || '').trim()}$`, "i") },
          ownerType: "admin"
        });
        
        if (!existingMaster) {
          const masterSlug = await ensureUniqueSlug(`${product.name}-master`);

          const sourceVariants =
            parsedVars.length > 0 ? parsedVars : product.variants || [];
          const normalizedMasterVariants = normalizeVariants(sourceVariants, {
            defaultUnit: product.unit,
            basePrice: sellPrice,
            baseSalePrice: sellPrice,
          });

          const newMasterData = {
            name: product.name,
            slug: masterSlug,
            description: product.description,
            price: sellPrice,
            salePrice: sellPrice,
            purchasePrice: product.price || 0,
            stock: totalVariantStock(normalizedMasterVariants) || Number(product.stock) || 0,
            unit: normalizeUnit(product.unit),
            categoryId: product.categoryId,
            subcategoryId: product.subcategoryId,
            brand: product.brand,
            weight: product.weight,
            tags: product.tags,
            status: "active",
            ownerType: "admin",
            mainImage: product.mainImage,
            galleryImages: product.galleryImages,
            variants: normalizedMasterVariants,
          };
          existingMaster = new Product(newMasterData);
          await existingMaster.save();
        } else {
          existingMaster.price = sellPrice;
          existingMaster.salePrice = sellPrice;
          await existingMaster.save();
        }
        
        productData.masterProductId = existingMaster._id;
      }

      delete productData.price;
      delete productData.salePrice;
      delete productData.purchasePrice;
      delete productData.customerPrice;
      delete productData.sellerId;
    } else if (role !== "admin") {
      delete productData.sellerId;
      
      // SOP: If seller is ONLY updating stock/images, don't force re-approval
      // If name, price or category changes, then it must go back to pending
      const sensitiveFields = ['name', 'price', 'salePrice', 'categoryId', 'subcategoryId'];
      const isSensitiveChange = sensitiveFields.some(f => productData[f] !== undefined && String(productData[f]) !== String(product[f]));
      
      if (isSensitiveChange) {
        productData.status = "pending_approval";
      } else {
        delete productData.status; // Keep existing status (active/rejected/etc)
      }
    }

    const hasVariantsPayload =
      req.body.variants !== undefined || productData.variants !== undefined;

    const stockOnlyUpdate =
      !hasVariantsPayload &&
      (productData.stock !== undefined || req.body.stock !== undefined) &&
      req.body.variantId === undefined &&
      productData.variantId === undefined &&
      req.body.variantIndex === undefined &&
      productData.variantIndex === undefined;

    if (variantStockRequiresSelection(product) && stockOnlyUpdate) {
      return handleResponse(
        res,
        400,
        "This product has variants. Choose a variant to update (variantId or variantIndex) or send the full variants array.",
        {
          requiresVariant: true,
          variants: listVariantsForStockPicker(product),
        },
      );
    }

    const singleVariantStock =
      variantStockRequiresSelection(product) &&
      !hasVariantsPayload &&
      (req.body.variantId !== undefined ||
        req.body.variantIndex !== undefined ||
        req.body.variantName !== undefined) &&
      (req.body.stock !== undefined || productData.stock !== undefined);

    if (singleVariantStock) {
      const idx = resolveVariantIndex(product, {
        variantId: req.body.variantId ?? productData.variantId,
        variantIndex: req.body.variantIndex ?? productData.variantIndex,
        variantName: req.body.variantName ?? productData.variantName,
      });
      if (idx === -2) {
        return handleResponse(res, 400, "variantId or variantIndex is required", {
          requiresVariant: true,
          variants: listVariantsForStockPicker(product),
        });
      }
      if (idx < 0) {
        return handleResponse(res, 400, "Variant not found", {
          variants: listVariantsForStockPicker(product),
        });
      }
      const newStock = Math.max(0, Number(req.body.stock ?? productData.stock) || 0);
      productData.variants = setVariantStockAtIndex(product.variants, idx, newStock);
      productData.stock = totalVariantStock(productData.variants);
      delete productData.variantId;
      delete productData.variantIndex;
      delete productData.variantName;
    }

    if (hasVariantsPayload) {
      const rawVariants = parseVariantsField(req.body.variants ?? productData.variants);
      const defaultUnit = normalizeUnit(productData.unit ?? product.unit);
      productData.unit = defaultUnit;
      if (rawVariants.length > 0) {
        productData.variants = normalizeVariants(rawVariants, {
          defaultUnit,
          basePrice: Number(productData.price ?? product.price) || 0,
          baseSalePrice: Number(productData.salePrice ?? product.salePrice) || 0,
        });
        syncRootFromFirstVariant(productData);
        if (productData.price === undefined && productData.variants[0]) {
          productData.price = productData.variants[0].price;
          productData.salePrice = productData.variants[0].salePrice;
        }
      } else {
        productData.variants = [];
        productData.stock = Math.max(0, Number(productData.stock ?? product.stock) || 0);
      }
    }

    // Smart Mapping & Merge Logic: If masterProductId is changed by Admin
    const oldMasterId = product.masterProductId;
    if (role === "admin" && productData.masterProductId && String(oldMasterId) !== String(productData.masterProductId)) {
      try {
        const newMasterId = productData.masterProductId;
        const targetMaster = await Product.findById(newMasterId);

        if (targetMaster) {
          // 1. Normalization: Update the seller's product name/slug to match Master Item
          productData.name = targetMaster.name;
          productData.slug = await ensureUniqueSlug(targetMaster.slug, product._id);
          productData.unit = targetMaster.unit;
          
          // 2. Check for existing record of the same Master ID for this Seller
          const existingSellerProduct = await Product.findOne({
            sellerId: product.sellerId,
            masterProductId: newMasterId,
            _id: { $ne: product._id }
          });

          if (existingSellerProduct) {
            // MERGE CASE: Add current stock to existing record and DELETE this one
            const newTotalStock = (Number(existingSellerProduct.stock) || 0) + (Number(productData.stock || product.stock) || 0);
            await Product.findByIdAndUpdate(existingSellerProduct._id, { stock: newTotalStock });
            
            // Delete the current duplicate product
            await Product.findByIdAndDelete(product._id);

            // Cleanup old master ghost if it was an auto-created orphan
            const oldMaster = await Product.findById(oldMasterId);
            if (oldMaster && oldMaster.ownerType === "admin" && oldMaster.status === "inactive") {
              const otherSellers = await Product.countDocuments({ masterProductId: oldMasterId });
              if (otherSellers === 0) {
                await Product.findByIdAndDelete(oldMasterId);
                await HubInventory.deleteOne({ productId: oldMasterId });
              }
            }

            return handleResponse(res, 200, `Merged into existing ${targetMaster.name} listing. Duplicate removed.`);
          }
        }

        // Cleanup old master ghost (for case where no merge was needed)
        const oldMaster = await Product.findById(oldMasterId);
        if (oldMaster && oldMaster.ownerType === "admin" && oldMaster.status === "inactive") {
          const otherSellers = await Product.countDocuments({ masterProductId: oldMasterId, _id: { $ne: product._id } });
          if (otherSellers === 0) {
            await Product.findByIdAndDelete(oldMasterId);
            await HubInventory.deleteOne({ productId: oldMasterId });
          }
        }
      } catch (err) {
        console.warn("Smart Merge failed", err.message);
      }
    }

    // Standardize masterProductId in update data
    if (productData.masterProductId === "" || productData.masterProductId === "null") {
      productData.masterProductId = null;
    } else if (productData.masterProductId && typeof productData.masterProductId === "string") {
      if (!productData.masterProductId.trim()) {
        productData.masterProductId = null;
      }
    }

    if (productData.name !== undefined) {
      productData.slug = await ensureUniqueSlug(
        normalizeOptionalString(productData.name) || product.name,
        product._id,
      );
    }

    // Handle Images
    if (req.files) {
      // Seller-style images
      if (req.files.mainImage && req.files.mainImage[0]) {
        productData.mainImage = await uploadToCloudinary(
          req.files.mainImage[0].buffer,
          "products",
        );
      }

      if (req.files.galleryImages && req.files.galleryImages.length > 0) {
        const uploadPromises = req.files.galleryImages.map((file) =>
          uploadToCloudinary(file.buffer, "products"),
        );
        const uploaded = await Promise.all(uploadPromises);
        if (Array.isArray(keepGalleryImages)) {
          productData.galleryImages = [...keepGalleryImages, ...uploaded].slice(0, 5);
        } else {
          productData.galleryImages = uploaded.slice(0, 5);
        }
      }

      // Admin-style images (array of 'images')
      if (req.files.images && req.files.images.length > 0) {
        const uploadPromises = req.files.images.map((file) =>
          uploadToCloudinary(file.buffer, "products"),
        );
        const uploadedImages = await Promise.all(uploadPromises);

        // For admin, we use the first as mainImage and rest as gallery
        if (uploadedImages.length > 0) {
          productData.mainImage = uploadedImages[0];
          productData.galleryImages = uploadedImages.slice(1);
          // Also support a generic 'images' field if schema has it (some versions did)
          productData.images = uploadedImages;
        }
      }
    }

    // If no new uploads but keepGalleryImages was provided, apply it (supports removal)
    if (productData.galleryImages === undefined && Array.isArray(keepGalleryImages)) {
      productData.galleryImages = keepGalleryImages.slice(0, 5);
    }

    if (typeof productData.tags === "string") {
      productData.tags = productData.tags.split(",").map((tag) => tag.trim());
    }

    const updatedProduct = await Product.findByIdAndUpdate(
      id,
      { $set: productData },
      { new: true, runValidators: true },
    );

    let finalProduct = updatedProduct;
    if (finalProduct?.variants?.length > 0) {
      const catalogStock = totalVariantStock(finalProduct.variants);
      if (finalProduct.stock !== catalogStock) {
        finalProduct = await Product.findByIdAndUpdate(
          id,
          { $set: { stock: catalogStock } },
          { new: true, runValidators: true },
        );
      }
    }

    // --- UNIVERSAL PROPAGATION: Master to Hub Inventory (Customer Selling Price) ---
    if (finalProduct.ownerType === 'admin') {
        const currentMasterPrice = Number(productData.price || finalProduct.price);
        if (currentMasterPrice > 0) {
            await mongoose.model("HubInventory").updateMany({ productId: id }, { $set: { sellPrice: currentMasterPrice } });
            console.log(`[Hub Sync] Master Product ${id} price updated. Customer selling price synced to Hub: ₹${currentMasterPrice}`);
            // Note: We NO LONGER update seller prices here. Sellers maintain their own procurement rates.
        }
    }

    // --- AUTO APPROVAL & MASTER PROMOTION Logic ---
    const currentStatus = (productData.status || (req.body && req.body.status) || "").toLowerCase();
    const customerPrice = Number(req.body.customerPrice);

    if (role === "admin") {
      let mid = finalProduct?.masterProductId;
      
      // 1. Try to find an existing master if not linked
      if (!mid) {
        const matchingMaster = await Product.findOne({
          name: { $regex: new RegExp(`^${updatedProduct.name}$`, "i") },
          ownerType: "admin"
        });
        if (matchingMaster) {
          mid = matchingMaster._id;
          // Link it now so future edits are consistent
          await Product.findByIdAndUpdate(updatedProduct._id, { masterProductId: mid });
        }
      }
      
      // 2. PROMOTION: If still no master and admin is activating, create a Master Record automatically
      if (!mid && currentStatus === "active") {
        try {
          console.log(`[updateProduct] No master found for ${updatedProduct.name}. Promoting to Master Catalog...`);
          
          const masterSlug = await ensureUniqueSlug(`${updatedProduct.name}-master`);
          const promotedVariants = normalizeVariants(updatedProduct.variants || [], {
            defaultUnit: updatedProduct.unit,
            basePrice: customerPrice || updatedProduct.price,
            baseSalePrice: customerPrice || updatedProduct.salePrice,
          });

          const newMaster = new Product({
            name: updatedProduct.name,
            slug: masterSlug,
            ownerType: "admin",
            status: "active",
            categoryId: updatedProduct.categoryId,
            subcategoryId: updatedProduct.subcategoryId,
            unit: normalizeUnit(updatedProduct.unit),
            mainImage: updatedProduct.mainImage,
            galleryImages: updatedProduct.galleryImages,
            description: updatedProduct.description,
            price: customerPrice || updatedProduct.price,
            salePrice: customerPrice || updatedProduct.salePrice,
            purchasePrice: updatedProduct.price,
            stock: totalVariantStock(promotedVariants),
            variants: promotedVariants,
          });
          
          const savedMaster = await newMaster.save();
          mid = savedMaster._id;
          
          // Link the seller product to this new master
          await Product.findByIdAndUpdate(updatedProduct._id, { masterProductId: mid });
          
          // Initialize Hub Inventory for this new master
          const HubInventory = mongoose.model("HubInventory");
          await HubInventory.findOneAndUpdate(
            { hubId: process.env.DEFAULT_HUB_ID || "MAIN_HUB", productId: mid },
            { $setOnInsert: { availableQty: 0, reservedQty: 0 } },
            { upsert: true }
          );
          
          console.log(`[updateProduct] SUCCESS: Created new Master Product ${mid} from approved Seller item.`);
        } catch (promErr) {
          console.error("[updateProduct] Master promotion failed:", promErr.message);
        }
      }
      
      // 3. SYNC: If we have a master ID, ensure status and customerPrice are synced ONLY to Master Catalog
      if (mid) {
        const masterUpdate = {};
        if (currentStatus === "active") masterUpdate.status = "active";
        
        // If Admin sends customerPrice, it updates the Master Catalog ONLY.
        // This ensures Seller's Vendor Price (Supply Price) stays separate.
        if (!isNaN(customerPrice) && customerPrice > 0) {
          masterUpdate.price = customerPrice;
          masterUpdate.salePrice = customerPrice;
          
          // SYNC VARIANTS: Ensure variants in Master Catalog also get the Selling Price
          const targetMaster = await Product.findById(mid);
          if (targetMaster?.variants?.length > 0) {
            masterUpdate.variants = targetMaster.variants.map((v) => {
              const variantObj = v.toObject ? v.toObject() : v;
              return {
                ...variantObj,
                price: customerPrice,
                salePrice: customerPrice,
                stock: Number(variantObj.stock) || 0,
              };
            });
            masterUpdate.stock = totalVariantStock(masterUpdate.variants);
          }
        }

        if (Object.keys(masterUpdate).length > 0) {
          try {
            await Product.findByIdAndUpdate(mid, { $set: masterUpdate });
            console.log(`[updateProduct] SUCCESS: Synced Master Product ${mid} with Customer Price: ₹${customerPrice || 'N/A'}`);
          } catch (err) {
            console.warn("[updateProduct] ERROR: Failed to sync master product:", err.message);
          }
        }
      }
    }

    if (finalProduct?.ownerType === "admin") {
      try {
        const candidateSellPrice =
          !isNaN(customerPrice) && customerPrice > 0
            ? Number(customerPrice)
            : Number(finalProduct.salePrice || 0) > 0
              ? Number(finalProduct.salePrice)
              : Number(finalProduct.price || 0);

        const hubQty =
          totalVariantStock(finalProduct.variants) ||
          Math.max(0, Number(finalProduct.stock) || 0);

        const stockTouched =
          hasVariantsPayload ||
          productData.stock !== undefined ||
          req.body.stock !== undefined;

        if (stockTouched) {
          await syncAdminHubStock(finalProduct._id, hubQty, {
            sellPrice: candidateSellPrice,
            reorderLevel: Number(finalProduct.lowStockAlert || 10),
          });
        } else {
          await HubInventory.findOneAndUpdate(
            { hubId: DEFAULT_HUB_ID, productId: finalProduct._id },
            {
              $setOnInsert: { availableQty: 0, reservedQty: 0 },
              $set: { reorderLevel: Number(finalProduct.lowStockAlert || 10) },
            },
            { upsert: true },
          );
          if (candidateSellPrice > 0) {
            await HubInventory.updateMany(
              {
                hubId: DEFAULT_HUB_ID,
                productId: finalProduct._id,
                $or: [{ sellPrice: { $exists: false } }, { sellPrice: { $lte: 0 } }],
              },
              { $set: { sellPrice: candidateSellPrice, priceUpdatedAt: new Date() } },
            );
          }
        }
      } catch (err) {
        console.warn("[updateProduct] Hub entry sync failed", err.message);
      }
    }

    let responseProduct = finalProduct;
    if (finalProduct?.ownerType === "admin") {
      const hubRow = await HubInventory.findOne({
        hubId: DEFAULT_HUB_ID,
        productId: finalProduct._id,
      }).lean();
      const hubQty = hubQtyFromInventoryRow(hubRow);
      const plain =
        typeof finalProduct.toObject === "function" ? finalProduct.toObject() : { ...finalProduct };
      responseProduct = {
        ...plain,
        stock: hubQty,
        catalogStock: hubQty,
        availableQtyHub: hubQty,
      };
    } else if (finalProduct?.ownerType === "seller") {
      const sellerQty = catalogStockFromProduct(finalProduct);
      const plain =
        typeof finalProduct.toObject === "function" ? finalProduct.toObject() : { ...finalProduct };
      responseProduct = {
        ...plain,
        stock: sellerQty,
        catalogStock: sellerQty,
        availableQtySeller: sellerQty,
      };
    }

    return handleResponse(
      res,
      200,
      "Product updated successfully",
      responseProduct,
    );
  } catch (error) {
    console.error("Update Product Error:", error);
    if (error.name === "ValidationError") {
      return handleResponse(
        res,
        400,
        Object.values(error.errors)
          .map((e) => e.message)
          .join(", "),
      );
    }
    if (error.name === "CastError") {
      return handleResponse(res, 400, `Invalid ${error.path}: ${error.value}`);
    }
    const dupMsg = duplicateKeyMessage(error);
    if (dupMsg) return handleResponse(res, 400, dupMsg);
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   DELETE PRODUCT
 ================================ */
export const deleteProduct = async (req, res) => {
  try {
    const { id } = req.params;
    const sellerId = req.user.id;
    const role = req.user.role;

    const query = role === "admin" ? { _id: id } : { _id: id, sellerId };
    const product = await Product.findOneAndDelete(query);

    if (!product) {
      return handleResponse(res, 404, "Product not found or unauthorized");
    }

    return handleResponse(res, 200, "Product deleted successfully");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/** Map one catalog row the same way as GET /products list (customer detail sheet). */
async function mapSingleProductForCustomerCatalog(productLean) {
  const p = productLean;
  const pIdStr = String(p._id);

  if (p.ownerType === "admin") {
    const hubRow = await HubInventory.findOne({
      hubId: DEFAULT_HUB_ID,
      productId: p._id,
    }).lean();
    const hubQty = hubQtyFromInventoryRow(hubRow);

    let mappedSellerStock = 0;
    let mappedSellerCost = Number(p.purchasePrice) || 0;
    try {
      const sellerAgg = await Product.aggregate([
        {
          $match: {
            masterProductId: new mongoose.Types.ObjectId(pIdStr),
            ownerType: "seller",
            status: "active",
          },
        },
        {
          $group: {
            _id: "$masterProductId",
            totalSellerStock: {
              $sum: {
                $cond: {
                  if: {
                    $and: [
                      { $isArray: "$variants" },
                      { $gt: [{ $size: "$variants" }, 0] },
                    ],
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
              },
            },
            minPurchasePrice: { $min: "$purchasePrice" },
            avgPurchasePrice: { $avg: "$purchasePrice" },
          },
        },
      ]);
      if (sellerAgg[0]) {
        mappedSellerStock = Number(sellerAgg[0].totalSellerStock || 0);
        mappedSellerCost =
          Number(sellerAgg[0].minPurchasePrice || sellerAgg[0].avgPurchasePrice) ||
          mappedSellerCost;
      }
    } catch (err) {
      console.warn("[getProductById] seller stock aggregation:", err.message);
    }

    const fulfillableQty = hubQty + mappedSellerStock;
    const dynamicPrice =
      hubRow?.sellPrice && hubRow.sellPrice > 0
        ? hubRow.sellPrice
        : p.salePrice || p.price;
    const hasVariants = Array.isArray(p.variants) && p.variants.length > 0;

    return {
      ...p,
      price: hasVariants ? p.price : dynamicPrice,
      salePrice: hasVariants ? p.salePrice || p.price : dynamicPrice,
      purchasePrice: mappedSellerCost,
      stock: hubQty,
      catalogStock: hubQty,
      availableQtyHub: hubQty,
      availableQtySeller: mappedSellerStock,
      totalAvailableQty: fulfillableQty,
      totalFulfillmentQty: fulfillableQty,
      variants: mapVariantsForResponse(p.variants),
      fulfillmentSource:
        hubQty > 0 ? "hub" : mappedSellerStock > 0 ? "procure" : "out_of_stock",
    };
  }

  const masterId = p.masterProductId?._id || p.masterProductId;
  let masterProduct = null;
  if (masterId) {
    masterProduct = await Product.findById(masterId).select("price salePrice").lean();
  }
  const customerPrice = masterProduct
    ? masterProduct.salePrice || masterProduct.price
    : p.salePrice || p.price;
  const sellerListingStock = catalogStockFromProduct(p);
  let hubQtyForSeller = 0;
  if (masterId) {
    const hubRow = await HubInventory.findOne({
      hubId: DEFAULT_HUB_ID,
      productId: masterId,
    }).lean();
    hubQtyForSeller = hubQtyFromInventoryRow(hubRow);
  }

  return {
    ...p,
    price: customerPrice || p.price,
    salePrice: customerPrice || p.salePrice,
    availableQtyHub: hubQtyForSeller,
    availableQtySeller: sellerListingStock,
    stock: sellerListingStock,
    catalogStock: sellerListingStock,
    sellerListingStock,
    totalAvailableQty: sellerListingStock,
    variants: mapVariantsForResponse(p.variants),
    fulfillmentSource: sellerListingStock > 0 ? "direct" : "out_of_stock",
  };
}

/* ===============================
   GET SINGLE PRODUCT
 ================================ */
export const getProductById = async (req, res) => {
  try {
    const { id } = req.params;
    const enforceCustomerCatalog = isCustomerVisibilityRequest(req);
    const coords = parseCustomerCoordinates(req.query || {});

    if (enforceCustomerCatalog && !coords.valid) {
      return handleResponse(
        res,
        400,
        "lat and lng are required for customer product visibility",
      );
    }

    let nearbySellerSet = null;
    if (enforceCustomerCatalog && coords.valid) {
      const nearbySellerIds = await getNearbySellerIdsForCustomer(
        coords.lat,
        coords.lng,
      );
      nearbySellerSet = new Set(nearbySellerIds.map(String));
    }

    const product = await Product.findById(id)
      .populate("categoryId", "name")
      .populate("subcategoryId", "name")
      .populate("sellerId", "shopName")
      .populate(
        "masterProductId",
        "description brand weight unit variants galleryImages mainImage",
      );

    if (!product) {
      return handleResponse(res, 404, "Product not found");
    }

    const productLean =
      typeof product.toObject === "function" ? product.toObject() : product;

    if (enforceCustomerCatalog) {
      if (String(productLean.status || "") !== "active") {
        return handleResponse(res, 404, "Product not available");
      }

      if (productLean.ownerType === "admin") {
        const hubRow = await HubInventory.findOne({
          hubId: DEFAULT_HUB_ID,
          productId: productLean._id,
          availableQty: { $gt: 0 },
        }).lean();
        const hasHubStock = Boolean(hubRow);
        let hasSellerStock = false;
        if (!hasHubStock) {
          hasSellerStock =
            (await Product.countDocuments({
              masterProductId: productLean._id,
              ownerType: "seller",
              status: "active",
              stock: { $gt: 0 },
            })) > 0;
        }
        if (!hasHubStock && !hasSellerStock) {
          return handleResponse(res, 404, "Product not available");
        }
      } else {
        const sellerIdForProduct = String(
          productLean.sellerId?._id || productLean.sellerId,
        );
        if (!nearbySellerSet || !nearbySellerSet.has(sellerIdForProduct)) {
          return handleResponse(res, 404, "Product not available in your area");
        }
      }
    }

    const role = String(req.user?.role || "").toLowerCase();
    let payload = productLean;

    if (role === "admin") {
      payload = productLean;
    } else if (enforceCustomerCatalog) {
      const mapped = await mapSingleProductForCustomerCatalog(productLean);
      payload = enrichCustomerProduct(mapped);
    } else {
      payload = enrichCustomerProduct(productLean);
    }

    return handleResponse(res, 200, "Product details fetched", payload);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE VARIANT STOCK (explicit)
 ================================ */
export const updateVariantStock = async (req, res) => {
  try {
    const { id } = req.params;
    const role = String(req.user?.role || "").toLowerCase();
    const sellerId = req.user.id;
    const { variantId, variantIndex, variantName, stock, delta, note } = req.body;

    const query = role === "admin" ? { _id: id } : { _id: id, sellerId };
    const product = await Product.findOne(query);
    if (!product) {
      return handleResponse(res, 404, "Product not found or unauthorized");
    }

    if (!variantStockRequiresSelection(product)) {
      const hasAbsolute = stock !== undefined && stock !== null && stock !== "";
      const numericDelta = Number(delta);
      const hasDelta = Number.isFinite(numericDelta) && numericDelta !== 0;

      if (!hasAbsolute && !hasDelta) {
        return handleResponse(res, 400, "stock or delta is required");
      }

      let nextStock = Math.max(0, Number(product.stock) || 0);
      if (hasAbsolute) {
        nextStock = Math.max(0, Number(stock) || 0);
      } else {
        nextStock = Math.max(0, nextStock + numericDelta);
      }

      product.stock = nextStock;
      await product.save();

      if (product.ownerType === "admin") {
        await syncAdminHubStock(product._id, nextStock, {
          sellPrice: Number(product.salePrice || product.price || 0),
          reorderLevel: Number(product.lowStockAlert || 10),
        });
      }

      return handleResponse(res, 200, "Product stock updated", {
        productId: product._id,
        stock: nextStock,
        variants: [],
      });
    }

    const idx = resolveVariantIndex(product, { variantId, variantIndex, variantName });
    if (idx === -2) {
      return handleResponse(
        res,
        400,
        "This product has variants. Specify variantId, variantIndex, or variantName.",
        {
          requiresVariant: true,
          variants: listVariantsForStockPicker(product),
        },
      );
    }
    if (idx < 0) {
      return handleResponse(res, 400, "Variant not found", {
        variants: listVariantsForStockPicker(product),
      });
    }

    const currentVariantStock = Math.max(0, Number(product.variants[idx]?.stock) || 0);
    const hasAbsolute = stock !== undefined && stock !== null && stock !== "";
    const numericDelta = Number(delta);
    const hasDelta = Number.isFinite(numericDelta) && numericDelta !== 0;

    if (!hasAbsolute && !hasDelta) {
      return handleResponse(res, 400, "stock (absolute) or delta (adjustment) is required");
    }

    let nextVariantStock = currentVariantStock;
    if (hasAbsolute) {
      nextVariantStock = Math.max(0, Number(stock) || 0);
    } else {
      nextVariantStock = Math.max(0, currentVariantStock + numericDelta);
    }

    const updatedVariants = setVariantStockAtIndex(product.variants, idx, nextVariantStock);
    const catalogStock = totalVariantStock(updatedVariants);
    const targetVariant = updatedVariants[idx];

    product.variants = updatedVariants;
    product.stock = catalogStock;
    product.markModified("variants");
    await product.save();

    if (product.ownerType === "admin") {
      await syncAdminHubStock(product._id, catalogStock, {
        sellPrice: Number(product.salePrice || product.price || 0),
        reorderLevel: Number(product.lowStockAlert || 10),
      });
    }

    return handleResponse(res, 200, "Variant stock updated", {
      productId: product._id,
      stock: catalogStock,
      variant: {
        variantId: targetVariant?._id ? String(targetVariant._id) : null,
        index: idx,
        name: targetVariant?.name,
        stock: nextVariantStock,
        unit: targetVariant?.unit,
      },
      variants: listVariantsForStockPicker({
        variants: updatedVariants,
        unit: product.unit,
      }),
      note: note || null,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/**
 * Utility to propagate price changes from a Master Product to all linked seller products.
 * Used by other controllers (e.g., during Stock Inwarding).
 */
export const propagatePriceUpdates = async (masterProduct) => {
    try {
        if (!masterProduct || masterProduct.ownerType !== 'admin') return;

        const newPrice = Number(masterProduct.price || masterProduct.salePrice || 0);
        if (newPrice <= 0) return;

        console.log(`[Exported Sync] Triggering full sync for Master ${masterProduct._id} -> ₹${newPrice}`);

        // 1. Update Hub Inventory selling price
        await mongoose.model("HubInventory").updateMany(
            { productId: masterProduct._id },
            { $set: { sellPrice: newPrice } }
        );

        console.log(`[Exported Sync] Hub price updated for Master ${masterProduct._id} -> ₹${newPrice}. Seller prices preserved.`);
    } catch (err) {
        console.error("[propagatePriceUpdates] Sync failed:", err.message);
    }
};
