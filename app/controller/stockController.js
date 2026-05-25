import Product from "../models/product.js";
import StockHistory from "../models/stockHistory.js";
import handleResponse from "../utils/helper.js";
import {
  listVariantsForStockPicker,
  resolveVariantIndex,
  setVariantStockAtIndex,
  totalVariantStock,
  variantStockRequiresSelection,
} from "../utils/productHelpers.js";

/* ===============================
   ADJUST STOCK MANUALLY
================================ */
export const adjustStock = async (req, res) => {
  try {
    const { productId, type, quantity, note, variantId, variantIndex, variantName } = req.body;
    const sellerId = req.user.id;

    const product = await Product.findOne({ _id: productId, sellerId });
    if (!product) {
      return handleResponse(res, 404, "Product not found or unauthorized");
    }

    const qtyChange = Math.abs(Number(quantity || 0));
    if (qtyChange <= 0) return handleResponse(res, 400, "Quantity must be greater than zero");

    const isRestock = type === "Restock";
    const signedDelta = isRestock ? qtyChange : -qtyChange;

    if (variantStockRequiresSelection(product)) {
      const idx = resolveVariantIndex(product, { variantId, variantIndex, variantName });
      if (idx === -2) {
        return handleResponse(
          res,
          400,
          "This product has variants. Select which variant to update (variantId or variantIndex).",
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

      const current = Math.max(0, Number(product.variants[idx]?.stock) || 0);
      const nextVariantStock = Math.max(0, current + signedDelta);
      const updatedVariants = setVariantStockAtIndex(product.variants, idx, nextVariantStock);
      const catalogStock = totalVariantStock(updatedVariants);

      product.variants = updatedVariants;
      product.stock = catalogStock;
      product.markModified("variants");
      await product.save();

      const historyEntry = new StockHistory({
        product: productId,
        seller: sellerId,
        type: isRestock ? "Restock" : "Correction",
        quantity: signedDelta,
        variantId: updatedVariants[idx]?._id || undefined,
        note:
          note ||
          `Manual ${type} on ${updatedVariants[idx]?.name || `variant ${idx + 1}`}`,
      });
      await historyEntry.save();

      return handleResponse(res, 200, "Variant stock adjusted successfully", {
        newStock: catalogStock,
        variant: {
          variantId: updatedVariants[idx]?._id
            ? String(updatedVariants[idx]._id)
            : null,
          index: idx,
          name: updatedVariants[idx]?.name,
          stock: nextVariantStock,
        },
        variants: listVariantsForStockPicker({
          variants: updatedVariants,
          unit: product.unit,
        }),
        historyEntry,
      });
    }

    let finalStock = Math.max(0, Number(product.stock) || 0) + signedDelta;
    if (finalStock < 0) {
      return handleResponse(res, 400, "Stock cannot be negative");
    }

    product.stock = finalStock;
    await product.save();

    const historyEntry = new StockHistory({
      product: productId,
      seller: sellerId,
      type: isRestock ? "Restock" : "Correction",
      quantity: signedDelta,
      note: note || `Manual ${type} adjustment`,
    });

    await historyEntry.save();

    return handleResponse(res, 200, "Stock adjusted successfully", {
      newStock: product.stock,
      historyEntry,
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   GET STOCK HISTORY LOG
================================ */
export const getStockHistory = async (req, res) => {
  try {
    const sellerId = req.user.id;

    const history = await StockHistory.find({ seller: sellerId })
      .sort({ createdAt: -1 })
      .populate("product", "name sku mainImage variants");

    return handleResponse(
      res,
      200,
      "Stock history fetched",
      history.map((item) => {
        const variantLabel =
          item.variantId && item.product?.variants?.length
            ? item.product.variants.find(
                (v) => String(v._id) === String(item.variantId),
              )?.name
            : null;
        return {
          id: item._id,
          productName: item.product?.name || "Deleted Product",
          sku: item.product?.sku || "N/A",
          variantName: variantLabel || null,
          type: item.type,
          quantity: item.quantity > 0 ? `+${item.quantity}` : `${item.quantity}`,
          date: item.createdAt.toISOString().split("T")[0],
          time: item.createdAt.toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          }),
          note: item.note,
        };
      }),
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
