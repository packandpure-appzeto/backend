import mongoose from "mongoose";

const promotionSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            trim: true,
            uppercase: true,
        },
        title: String,
        description: String,
        promotionType: {
            type: String,
            enum: ["coupon", "automatic"],
            default: "coupon",
        },
        discountType: {
            type: String,
            enum: ["percentage", "fixed", "free_delivery"],
            required: true,
        },
        discountValue: Number,
        maxDiscount: Number,
        priority: {
            type: Number,
            default: 1,
        },
        conditions: {
            minOrderValue: Number,
            maxOrderValue: Number,
            minQuantity: Number,
            firstOrderOnly: {
                type: Boolean,
                default: false,
            },
            newUserOnly: {
                type: Boolean,
                default: false,
            },
            applicableCategories: [
                {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "Category",
                },
            ],
            applicableProducts: [
                {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "Product",
                },
            ],
            applicableUsers: [
                {
                    type: mongoose.Schema.Types.ObjectId,
                    ref: "User",
                },
            ],
        },
        usageLimit: Number,
        perUserLimit: {
            type: Number,
            default: 1,
        },
        usedCount: {
            type: Number,
            default: 0,
        },
        autoApply: {
            type: Boolean,
            default: false,
        },
        stackable: {
            type: Boolean,
            default: false,
        },
        validFrom: Date,
        validTill: Date,
        isActive: {
            type: Boolean,
            default: true,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Admin",
        },
    },
    {
        timestamps: true,
    }
);

promotionSchema.index({ code: 1 });
promotionSchema.index({ isActive: 1, validFrom: 1, validTill: 1 });
promotionSchema.index({ promotionType: 1 });

export default mongoose.model("Promotion", promotionSchema);
