import Category from "../models/category.js";
import mongoose from "mongoose";
import handleResponse from "../utils/helper.js";
import getPagination from "../utils/pagination.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";

const CATEGORY_TYPES = new Set(["category", "subcategory"]);

const normalizeParentId = (value) => {
  if (value === "" || value === "null" || value === null || value === undefined) return null;
  return value;
};

const CATEGORY_WRITABLE_KEYS = [
  "name",
  "slug",
  "description",
  "status",
  "type",
  "parentId",
  "order",
  "iconId",
  "headerColor",
];

function pickWritableCategoryFields(body) {
  const out = {};
  for (const k of CATEGORY_WRITABLE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(body, k)) continue;
    let v = body[k];
    if (k === "order") {
      const n = Number(v);
      out[k] = Number.isFinite(n) ? n : 0;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const validateHierarchy = async ({
  res,
  type,
  parentId,
  currentId = null,
}) => {
  if (!CATEGORY_TYPES.has(type)) {
    handleResponse(res, 400, "Invalid category type");
    return { ok: false };
  }

  if (type === "category") {
    if (parentId) {
      handleResponse(res, 400, "Parent categories must be root — parentId must be empty");
      return { ok: false };
    }
    return { ok: true };
  }

  if (type === "subcategory") {
    if (!parentId) {
      handleResponse(res, 400, "Parent category is required for subcategories");
      return { ok: false };
    }
    if (!mongoose.Types.ObjectId.isValid(parentId)) {
      handleResponse(res, 400, "Invalid parent category id");
      return { ok: false };
    }
    if (currentId && String(parentId) === String(currentId)) {
      handleResponse(res, 400, "Category cannot be its own parent");
      return { ok: false };
    }
    const parent = await Category.findById(parentId).select("type parentId").lean();
    if (!parent) {
      handleResponse(res, 400, "Parent category not found");
      return { ok: false };
    }
    if (parent.type !== "category" || parent.parentId != null) {
      handleResponse(res, 400, "Subcategory parent must be a root parent category");
      return { ok: false };
    }
    return { ok: true };
  }

  return { ok: false };
};

export const getCategories = async (req, res) => {
  try {
    const { flat, tree, roots, type } = req.query;
    const selectFields = "name slug image type parentId status order";

    /** Storefront home / browse — active parent categories only (name + image). */
    if (roots === "true") {
      const categories = await Category.find({
        type: "category",
        parentId: null,
        status: "active",
      })
        .select(selectFields)
        .sort({ order: 1, name: 1 })
        .lean();
      return handleResponse(res, 200, "Root categories fetched", categories);
    }

    if (tree === "true") {
      const categories = await Category.find({
        type: "category",
        parentId: null,
        status: "active",
      })
        .select(selectFields)
        .populate({
          path: "children",
          match: { type: "subcategory", status: "active" },
          select: selectFields,
          options: { sort: { order: 1, name: 1 } },
        })
        .sort({ order: 1, name: 1 })
        .lean();
      return handleResponse(res, 200, "Category tree fetched", categories);
    }

    const pageParam = req.query.page;
    const limitParam = req.query.limit;
    if (pageParam != null || limitParam != null) {
      const { page, limit, skip } = getPagination(req, {
        defaultLimit: 25,
        maxLimit: 100,
      });
      const query = {};
      if (type === "category" || type === "subcategory") {
        query.type = type;
      }
      const search = (req.query.search || "").trim();
      if (search) {
        query.$or = [
          { name: { $regex: search, $options: "i" } },
          { slug: { $regex: search, $options: "i" } },
        ];
      }
      const [items, total] = await Promise.all([
        Category.find(query).sort({ order: 1, name: 1 }).skip(skip).limit(limit).lean(),
        Category.countDocuments(query),
      ]);
      return handleResponse(res, 200, "Categories fetched successfully", {
        items,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      });
    }

    const query = {};
    if (type === "category" || type === "subcategory") {
      query.type = type;
    }
    const parentId = (req.query.parentId || "").trim();
    if (parentId) {
      query.parentId = parentId;
    }
    const search = (req.query.search || "").trim();
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { slug: { $regex: search, $options: "i" } },
      ];
    }
    const categories = await Category.find(query).sort({ order: 1, name: 1 }).lean();
    return handleResponse(
      res,
      200,
      "Categories fetched successfully",
      categories,
    );
  } catch (error) {
    if (error.name === "ValidationError") {
      return handleResponse(res, 400, error.message);
    }
    return handleResponse(res, 500, error.message);
  }
};

export const createCategory = async (req, res) => {
  try {
    const categoryData = pickWritableCategoryFields(req.body);

    if (!String(categoryData.name || "").trim()) {
      return handleResponse(res, 400, "Name is required");
    }

    if (req.file) {
      categoryData.image = await uploadToCloudinary(
        req.file.buffer,
        "categories",
      );
    }

    categoryData.parentId = normalizeParentId(categoryData.parentId);

    if (!categoryData.type) {
      return handleResponse(res, 400, "Type is required");
    }

    const { ok } = await validateHierarchy({
      res,
      type: categoryData.type,
      parentId: categoryData.parentId,
    });
    if (!ok) return;

    if (!categoryData.slug && categoryData.name) {
      categoryData.slug = categoryData.name
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/[\s_-]+/g, "-")
        .replace(/^-+|-+$/g, "");

      const existing = await Category.findOne({ slug: categoryData.slug });
      if (existing) {
        categoryData.slug = `${categoryData.slug}-${Date.now().toString().slice(-4)}`;
      }
    }

    const category = await Category.create(categoryData);
    return handleResponse(res, 201, "Category created successfully", category);
  } catch (error) {
    console.error("Create Category Error:", error);
    if (error.code === 11000) {
      return handleResponse(res, 400, "Slug already exists");
    }
    if (error.name === "ValidationError") {
      return handleResponse(res, 400, error.message);
    }
    return handleResponse(res, 500, error.message);
  }
};

export const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const categoryData = pickWritableCategoryFields(req.body);
    const hasParentId = Object.prototype.hasOwnProperty.call(req.body, "parentId");

    const existing = await Category.findById(id).select("type parentId").lean();
    if (!existing) {
      return handleResponse(res, 404, "Category not found");
    }

    if (req.file) {
      categoryData.image = await uploadToCloudinary(
        req.file.buffer,
        "categories",
      );
    }

    if (hasParentId) {
      categoryData.parentId = normalizeParentId(categoryData.parentId);
    }

    const nextType = categoryData.type || existing.type;
    const nextParentId = hasParentId ? categoryData.parentId : existing.parentId;

    if (nextType === "category" && !hasParentId) {
      categoryData.parentId = null;
    }

    const { ok } = await validateHierarchy({
      res,
      type: nextType,
      parentId: nextParentId,
      currentId: id,
    });
    if (!ok) return;

    const updatedCategory = await Category.findByIdAndUpdate(
      id,
      { $set: categoryData },
      { new: true, runValidators: true },
    );

    if (!updatedCategory) {
      return handleResponse(res, 404, "Category not found");
    }

    return handleResponse(
      res,
      200,
      "Category updated successfully",
      updatedCategory,
    );
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};

export const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;

    const deleteWithChildren = async (parentId) => {
      const children = await Category.find({ parentId });
      for (const child of children) {
        await deleteWithChildren(child._id);
      }
      await Category.findByIdAndDelete(parentId);
    };

    await deleteWithChildren(id);

    return handleResponse(res, 200, "Category and all descendants deleted");
  } catch (error) {
    return handleResponse(res, 500, error.message);
  }
};
