/**
 * Build the self-contained demo SQLite database (eval/sample/demo.db) used by the
 * sample eval dataset and the demo MCP configuration. Deterministic, no network.
 */
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { dirname, join } from "node:path";

const OUT = join(import.meta.dir, "..", "eval", "sample", "demo.db");

interface Customer { id: number; name: string; city: string; signup_date: string }
interface Category { id: number; name: string }
interface Product { id: number; name: string; category_id: number; price: number; stock: number }
interface Order { id: number; customer_id: number; order_date: string; status: string }
interface OrderItem { id: number; order_id: number; product_id: number; quantity: number; unit_price: number }

const customers: Customer[] = [
  { id: 1, name: "Alice Zhang", city: "Beijing", signup_date: "2024-01-15" },
  { id: 2, name: "Bob Li", city: "Shanghai", signup_date: "2024-02-20" },
  { id: 3, name: "Carol Wang", city: "Beijing", signup_date: "2024-03-05" },
  { id: 4, name: "Dave Chen", city: "Shenzhen", signup_date: "2024-04-11" },
  { id: 5, name: "Eve Liu", city: "Hangzhou", signup_date: "2024-05-30" },
  { id: 6, name: "Frank Xu", city: "Beijing", signup_date: "2024-06-18" },
  { id: 7, name: "Grace Sun", city: "Chengdu", signup_date: "2024-07-22" },
  { id: 8, name: "Henry Zhou", city: "Shanghai", signup_date: "2024-08-09" },
  { id: 9, name: "Ivy Wu", city: "Hangzhou", signup_date: "2024-09-14" },
  { id: 10, name: "Jack Ma", city: "Shenzhen", signup_date: "2024-10-01" },
];

const categories: Category[] = [
  { id: 1, name: "Beverages" },
  { id: 2, name: "Snacks" },
  { id: 3, name: "Electronics" },
  { id: 4, name: "Books" },
];

const products: Product[] = [
  { id: 1, name: "Green Tea", category_id: 1, price: 25.5, stock: 100 },
  { id: 2, name: "Coffee Beans", category_id: 1, price: 68.0, stock: 60 },
  { id: 3, name: "Orange Juice", category_id: 1, price: 12.0, stock: 200 },
  { id: 4, name: "Potato Chips", category_id: 2, price: 8.5, stock: 300 },
  { id: 5, name: "Chocolate Bar", category_id: 2, price: 15.0, stock: 250 },
  { id: 6, name: "Almonds", category_id: 2, price: 45.0, stock: 80 },
  { id: 7, name: "Wireless Mouse", category_id: 3, price: 129.0, stock: 40 },
  { id: 8, name: "USB-C Cable", category_id: 3, price: 39.9, stock: 150 },
  { id: 9, name: "Bluetooth Speaker", category_id: 3, price: 299.0, stock: 25 },
  { id: 10, name: "Database Systems", category_id: 4, price: 99.0, stock: 30 },
  { id: 11, name: "SQL Cookbook", category_id: 4, price: 79.5, stock: 45 },
  { id: 12, name: "TypeScript in Depth", category_id: 4, price: 88.0, stock: 35 },
];

const orders: Order[] = [
  { id: 1, customer_id: 1, order_date: "2024-03-01", status: "completed" },
  { id: 2, customer_id: 2, order_date: "2024-03-03", status: "completed" },
  { id: 3, customer_id: 1, order_date: "2024-04-10", status: "completed" },
  { id: 4, customer_id: 3, order_date: "2024-04-15", status: "cancelled" },
  { id: 5, customer_id: 4, order_date: "2024-05-02", status: "completed" },
  { id: 6, customer_id: 5, order_date: "2024-05-20", status: "completed" },
  { id: 7, customer_id: 6, order_date: "2024-06-01", status: "pending" },
  { id: 8, customer_id: 7, order_date: "2024-07-07", status: "completed" },
  { id: 9, customer_id: 8, order_date: "2024-07-19", status: "completed" },
  { id: 10, customer_id: 9, order_date: "2024-08-25", status: "completed" },
  { id: 11, customer_id: 10, order_date: "2024-09-09", status: "cancelled" },
  { id: 12, customer_id: 2, order_date: "2024-10-10", status: "completed" },
  { id: 13, customer_id: 3, order_date: "2024-10-12", status: "pending" },
  { id: 14, customer_id: 1, order_date: "2024-10-15", status: "completed" },
  { id: 15, customer_id: 5, order_date: "2024-10-20", status: "pending" },
];

const orderItems: OrderItem[] = [
  { id: 1, order_id: 1, product_id: 1, quantity: 2, unit_price: 25.5 },
  { id: 2, order_id: 1, product_id: 4, quantity: 3, unit_price: 8.5 },
  { id: 3, order_id: 2, product_id: 7, quantity: 1, unit_price: 129.0 },
  { id: 4, order_id: 3, product_id: 10, quantity: 1, unit_price: 99.0 },
  { id: 5, order_id: 3, product_id: 11, quantity: 1, unit_price: 79.5 },
  { id: 6, order_id: 4, product_id: 2, quantity: 1, unit_price: 68.0 },
  { id: 7, order_id: 5, product_id: 9, quantity: 1, unit_price: 299.0 },
  { id: 8, order_id: 5, product_id: 8, quantity: 2, unit_price: 39.9 },
  { id: 9, order_id: 6, product_id: 5, quantity: 5, unit_price: 15.0 },
  { id: 10, order_id: 7, product_id: 3, quantity: 4, unit_price: 12.0 },
  { id: 11, order_id: 8, product_id: 12, quantity: 1, unit_price: 88.0 },
  { id: 12, order_id: 8, product_id: 6, quantity: 2, unit_price: 45.0 },
  { id: 13, order_id: 9, product_id: 7, quantity: 2, unit_price: 129.0 },
  { id: 14, order_id: 10, product_id: 1, quantity: 1, unit_price: 25.5 },
  { id: 15, order_id: 10, product_id: 2, quantity: 1, unit_price: 68.0 },
  { id: 16, order_id: 10, product_id: 4, quantity: 1, unit_price: 8.5 },
  { id: 17, order_id: 11, product_id: 9, quantity: 1, unit_price: 299.0 },
  { id: 18, order_id: 12, product_id: 10, quantity: 2, unit_price: 99.0 },
  { id: 19, order_id: 13, product_id: 3, quantity: 6, unit_price: 12.0 },
  { id: 20, order_id: 14, product_id: 6, quantity: 1, unit_price: 45.0 },
  { id: 21, order_id: 14, product_id: 11, quantity: 2, unit_price: 79.5 },
  { id: 22, order_id: 15, product_id: 8, quantity: 3, unit_price: 39.9 },
];

function build(): void {
  if (existsSync(OUT)) {
    console.log(`demo database already exists: ${OUT}`);
    return;
  }
  mkdirSync(dirname(OUT), { recursive: true });
  const db = new Database(OUT);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category_id INTEGER NOT NULL REFERENCES categories(id),
      price REAL NOT NULL,
      stock INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE customers (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      city TEXT NOT NULL,
      signup_date TEXT NOT NULL
    );
    CREATE TABLE orders (
      id INTEGER PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      order_date TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','completed','cancelled'))
    );
    CREATE TABLE order_items (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL
    );
  `);
  const ins = <T>(sql: string, rows: T[], fields: (keyof T)[]) => {
    const stmt = db.query(sql);
    for (const r of rows) stmt.run(...(fields.map((f) => r[f]) as (string | number | null)[]));
  };
  ins("INSERT INTO categories VALUES (?, ?)", categories, ["id", "name"]);
  ins("INSERT INTO products VALUES (?, ?, ?, ?, ?)", products, ["id", "name", "category_id", "price", "stock"]);
  ins("INSERT INTO customers VALUES (?, ?, ?, ?)", customers, ["id", "name", "city", "signup_date"]);
  ins("INSERT INTO orders VALUES (?, ?, ?, ?)", orders, ["id", "customer_id", "order_date", "status"]);
  ins("INSERT INTO order_items VALUES (?, ?, ?, ?, ?)", orderItems, ["id", "order_id", "product_id", "quantity", "unit_price"]);
  db.close();
  console.log(`demo database created: ${OUT}`);
}

build();
