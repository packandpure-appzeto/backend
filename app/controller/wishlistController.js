import Wishlist from "../models/wishlist.js";
import handleResponse from "../utils/helper.js";
import { enrichCustomerProduct } from "../utils/productHelpers.js";

const WISHLIST_PRODUCT_POPULATE = {
  path: "products",
  select:
    "name slug description price salePrice purchasePrice stock brand weight unit mainImage galleryImages status variants categoryId subcategoryId ownerType",
  populate: [
    { path: "categoryId", select: "name" },
    { path: "subcategoryId", select: "name" },
  ],
};

function mapWishlistProducts(products = []) {
  return (products || []).map((p) =>
    typeof p === "object" && p !== null && p._id
      ? enrichCustomerProduct(
          typeof p.toObject === "function" ? p.toObject() : { ...p },
        )
      : p,
  );
}

async function populateWishlist(query) {
  return query.populate(WISHLIST_PRODUCT_POPULATE).lean();
}

/* ===============================
   GET CUSTOMER WISHLIST
================================ */
export const getWishlist = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { idsOnly } = req.query;

    let query = Wishlist.findOne({ customerId });

    if (idsOnly === "true") {
      // Only select the products array (which contains IDs)
      const wishlist = await query.select("products").lean();
      return handleResponse(
        res,
        200,
        "Wishlist IDs fetched",
        wishlist || { products: [] },
      );
    }

    const wishlist = await populateWishlist(query);

    if (!wishlist) {
      const newWishlist = await Wishlist.create({ customerId, products: [] });
      return handleResponse(
        res,
        200,
        "Wishlist fetched successfully",
        { ...newWishlist.toObject(), products: [] },
      );
    }

    return handleResponse(res, 200, "Wishlist fetched successfully", {
      ...wishlist,
      products: mapWishlistProducts(wishlist.products),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   ADD TO WISHLIST
================================ */
export const addToWishlist = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { productId } = req.body;

    let wishlist = await Wishlist.findOne({ customerId });

    if (!wishlist) {
      wishlist = new Wishlist({ customerId, products: [] });
    }

    if (!wishlist.products.includes(productId)) {
      wishlist.products.push(productId);
    }

    await wishlist.save();
    const updatedWishlist = await populateWishlist(
      Wishlist.findById(wishlist._id),
    );

    return handleResponse(
      res,
      200,
      "Product added to wishlist",
      {
        ...updatedWishlist,
        products: mapWishlistProducts(updatedWishlist?.products),
      },
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   REMOVE FROM WISHLIST
================================ */
export const removeFromWishlist = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { productId } = req.params;

    let wishlist = await Wishlist.findOne({ customerId });

    if (!wishlist) {
      return handleResponse(res, 404, "Wishlist not found");
    }

    wishlist.products = wishlist.products.filter(
      (id) => id.toString() !== productId,
    );

    await wishlist.save();
    const updatedWishlist = await populateWishlist(
      Wishlist.findById(wishlist._id),
    );

    return handleResponse(
      res,
      200,
      "Product removed from wishlist",
      {
        ...updatedWishlist,
        products: mapWishlistProducts(updatedWishlist?.products),
      },
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

/* ===============================
   TOGGLE WISHLIST
================================ */
export const toggleWishlist = async (req, res) => {
  try {
    const customerId = req.user.id;
    const { productId } = req.body;

    let wishlist = await Wishlist.findOne({ customerId });

    if (!wishlist) {
      wishlist = new Wishlist({ customerId, products: [] });
    }

    const index = wishlist.products.indexOf(productId);
    let message = "";

    if (index > -1) {
      wishlist.products.splice(index, 1);
      message = "Product removed from wishlist";
    } else {
      wishlist.products.push(productId);
      message = "Product added to wishlist";
    }

    await wishlist.save();
    const updatedWishlist = await populateWishlist(
      Wishlist.findById(wishlist._id),
    );

    return handleResponse(res, 200, message, {
      ...updatedWishlist,
      products: mapWishlistProducts(updatedWishlist?.products),
    });
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
