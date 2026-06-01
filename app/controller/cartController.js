import Cart from "../models/cart.js";
import Product from "../models/product.js";
import handleResponse from "../utils/helper.js";

const CART_POPULATE_FIELDS =
  "name slug price salePrice mainImage stock status categoryId subcategoryId sellerId unit variants";

function findVariant(productDoc, variantId) {
  if (!variantId) return null;
  const list = productDoc?.variants;
  if (!Array.isArray(list) || list.length === 0) return null;
  return (
    list.find((v) => String(v?._id) === String(variantId)) ||
    list.find((v) => String(v?.id) === String(variantId)) ||
    null
  );
}

function getSellPrice(productDoc, variant) {
  if (variant) {
    const sale = Number(variant.salePrice ?? variant.price) || 0;
    const mrp = Number(variant.price) || sale;
    return { sale, mrp };
  }
  const baseSale = Number(productDoc.salePrice || productDoc.price) || 0;
  const baseMrp = Number(productDoc.price) || baseSale;
  return { sale: baseSale, mrp: baseMrp };
}

function getAvailableStock(productDoc, variant) {
  if (variant) return Math.max(0, Number(variant.stock) || 0);
  // If product has variants, stock at root is a sum; but for non-variant add we use root stock
  return Math.max(0, Number(productDoc.stock) || 0);
}

/* ===============================
   GET CUSTOMER CART
================================ */
export const getCart = async (req, res) => {
  try {
    const customerId = req.user.id;
    let cart = await Cart.findOne({ customerId })
      .populate("items.productId", CART_POPULATE_FIELDS)
      .lean();

    if (!cart) {
      const newCart = await Cart.create({ customerId, items: [] });
      return handleResponse(res, 200, "Cart fetched successfully", newCart);
    }

    return handleResponse(res, 200, "Cart fetched successfully", cart);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   ADD TO CART
================================ */
export const addToCart = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { productId, quantity = 1, variantId = null } = req.body;
    const qty = Math.max(1, Number(quantity) || 1);

    const product = await Product.findById(productId)
      .select(CART_POPULATE_FIELDS)
      .lean();
    if (!product) return handleResponse(res, 404, "Product not found");
    if (String(product.status || "") !== "active") {
      return handleResponse(res, 400, "Product is inactive");
    }

    const variant = variantId ? findVariant(product, variantId) : null;
    if (Array.isArray(product.variants) && product.variants.length > 0) {
      if (!variantId || !variant) {
        return handleResponse(res, 400, "Please select a product variant");
      }
    } else if (variantId && !variant) {
      return handleResponse(res, 400, "Variant not found");
    }

    const available = getAvailableStock(product, variant);
    if (available <= 0) {
      return handleResponse(res, 400, "Out of stock");
    }

    let cart = await Cart.findOne({ customerId });

    if (!cart) {
      cart = new Cart({ customerId, items: [] });
    }

    const normProductId = String(productId);
    const normVariantId = variantId ? String(variantId) : "";
    const itemIndex = cart.items.findIndex((item) => {
      const sameProduct = String(item.productId) === normProductId;
      const itemVar = item.variantId ? String(item.variantId) : "";
      return sameProduct && itemVar === normVariantId;
    });

    if (itemIndex > -1) {
      const nextQty = Math.max(1, Number(cart.items[itemIndex].quantity || 0) + qty);
      if (nextQty > available) {
        return handleResponse(res, 400, "Insufficient stock", {
          available,
          requested: nextQty,
        });
      }
      cart.items[itemIndex].quantity = nextQty;
    } else {
      if (qty > available) {
        return handleResponse(res, 400, "Insufficient stock", {
          available,
          requested: qty,
        });
      }
      cart.items.push({
        productId,
        quantity: qty,
        variantId: variantId || undefined,
      });
    }

    await cart.save();
    const updatedCart = await Cart.findById(cart._id)
      .populate("items.productId", CART_POPULATE_FIELDS)
      .lean();

    return handleResponse(res, 200, "Item added to cart", updatedCart);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   UPDATE QUANTITY
================================ */
export const updateQuantity = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { productId, quantity, variantId = null } = req.body;
    const qty = Math.max(0, Number(quantity) || 0);

    let cart = await Cart.findOne({ customerId });

    if (!cart) {
      return handleResponse(res, 404, "Cart not found");
    }

    const normProductId = String(productId);
    const normVariantId = variantId ? String(variantId) : "";
    const itemIndex = cart.items.findIndex((item) => {
      const sameProduct = String(item.productId) === normProductId;
      const itemVar = item.variantId ? String(item.variantId) : "";
      return sameProduct && itemVar === normVariantId;
    });

    if (itemIndex > -1) {
      if (qty <= 0) {
        cart.items.splice(itemIndex, 1);
      } else {
        const product = await Product.findById(productId)
          .select(CART_POPULATE_FIELDS)
          .lean();
        if (!product) return handleResponse(res, 404, "Product not found");
        if (String(product.status || "") !== "active") {
          return handleResponse(res, 400, "Product is inactive");
        }

        const variant = variantId ? findVariant(product, variantId) : null;
        if (variantId && !variant) {
          return handleResponse(res, 400, "Variant not found");
        }

        const available = getAvailableStock(product, variant);
        if (available <= 0) {
          return handleResponse(res, 400, "Out of stock");
        }
        if (qty > available) {
          return handleResponse(res, 400, "Insufficient stock", {
            available,
            requested: qty,
          });
        }

        cart.items[itemIndex].quantity = qty;
      }
    } else {
      return handleResponse(res, 404, "Product not in cart");
    }

    await cart.save();
    const updatedCart = await Cart.findById(cart._id)
      .populate("items.productId", CART_POPULATE_FIELDS)
      .lean();

    return handleResponse(res, 200, "Cart updated successfully", updatedCart);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   REMOVE FROM CART
================================ */
export const removeFromCart = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { productId } = req.params;
    const { variantId = null } = req.query;

    let cart = await Cart.findOne({ customerId });

    if (!cart) {
      return handleResponse(res, 404, "Cart not found");
    }

    cart.items = cart.items.filter((item) => {
      if (item.productId.toString() !== productId) return true;
      if (!variantId) return false;
      return String(item.variantId || "") !== String(variantId);
    });

    await cart.save();
    const updatedCart = await Cart.findById(cart._id).populate(
      "items.productId",
      CART_POPULATE_FIELDS,
    );

    return handleResponse(res, 200, "Item removed from cart", updatedCart);
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   CLEAR CART
================================ */
export const clearCart = async (req, res) => {
  try {
    const customerId = req.user.id;
    let cart = await Cart.findOne({ customerId });

    if (cart) {
      cart.items = [];
      await cart.save();
    }

    return handleResponse(res, 200, "Cart cleared successfully");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
