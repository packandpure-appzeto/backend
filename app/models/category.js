import mongoose from "mongoose";

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    description: {
      type: String,
      trim: true,
    },
    image: {
      type: String, // Cloudinary URL
    },
    iconId: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ["active", "inactive"],
      default: "active",
    },
    /** Parent category (root, `parentId: null`) or subcategory (child of a parent category). */
    type: {
      type: String,
      enum: ["category", "subcategory"],
      required: true,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Category",
      default: null,
    },
    headerColor: {
      type: String,
      trim: true, // optional accent (admin / storefront)
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

categorySchema.index({ type: 1, status: 1, order: 1 });
categorySchema.index({ parentId: 1, status: 1, order: 1 });
categorySchema.index({ name: 1 });

categorySchema.virtual("children", {
  ref: "Category",
  localField: "_id",
  foreignField: "parentId",
});

export default mongoose.model("Category", categorySchema);
