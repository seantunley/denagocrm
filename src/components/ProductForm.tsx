import { createProduct } from "@/app/actions/products";

export default function ProductForm() {
  return (
    <form action={createProduct} className="card space-y-4">
      <div>
        <label className="label">Model name *</label>
        <input name="name" className="input" required placeholder="e.g. Denago EV Rover XL" />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">SKU</label>
          <input name="sku" className="input" />
        </div>
        <div>
          <label className="label">Category</label>
          <input name="category" className="input" placeholder="e.g. Electric utility vehicle" />
        </div>
      </div>
      <div>
        <label className="label">Base price (R)</label>
        <input name="basePrice" className="input" inputMode="decimal" placeholder="0.00" />
      </div>
      <div>
        <label className="label">Available colours (comma-separated)</label>
        <input name="colors" className="input" placeholder="Gray, Lava, White, Black, Blue, Verdant" />
      </div>
      <div>
        <label className="label">Description</label>
        <textarea name="description" className="input" rows={3} />
      </div>
      <button className="btn-primary">Create product</button>
    </form>
  );
}
