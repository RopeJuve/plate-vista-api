// A realistic demo menu for development and demos only. Photos are from
// Unsplash (free to use, https://unsplash.com/license), each checked to show
// the dish it is named after.
const photo = (id) => `https://images.unsplash.com/photo-${id}?w=800&q=80&auto=format&fit=crop`;

export const SAMPLE_MENU = [
  // Starters
  { category: "Starters", title: "Bruschetta", priceCents: 650, description: "Grilled bread, tomatoes, basil, garlic", image: photo("1572695157366-5e585ab2b69f") },
  { category: "Starters", title: "Garlic Prawns", priceCents: 990, description: "Prawns in garlic and chili butter", image: photo("1559847844-5315695dadae") },
  // Soups
  { category: "Soups", title: "Tomato Soup", priceCents: 550, description: "Roasted tomatoes, cream, basil", image: photo("1547592166-23ac45744acd") },
  { category: "Soups", title: "Pumpkin Soup", priceCents: 590, description: "With roasted pumpkin seeds and feta", image: photo("1476718406336-bb5a9690ee2a") },
  // Salads
  { category: "Salads", title: "Caesar Salad", priceCents: 950, description: "Romaine, parmesan, croutons, Caesar dressing", image: photo("1546793665-c74683f339c1"), popular: true },
  { category: "Salads", title: "Buddha Bowl", priceCents: 1150, description: "Avocado, chickpeas, sweet potato, greens", image: photo("1512621776951-a57141f2eefd") },
  { category: "Salads", title: "Thai Beef Salad", priceCents: 1350, description: "Seared beef, herbs, lime and chili", image: photo("1504674900247-0877df9cc836") },
  // Pizza
  { category: "Pizza", title: "Pizza Margherita", priceCents: 950, description: "Tomato, mozzarella, basil", image: photo("1574071318508-1cdbab80d002"), popular: true },
  { category: "Pizza", title: "Pizza Vegetariana", priceCents: 1100, description: "Peppers, onions, mushrooms, olives", image: photo("1565299624946-b28f40a0ae38") },
  { category: "Pizza", title: "Pizza Rustica", priceCents: 1250, description: "Salami, cherry tomatoes, rosemary", image: photo("1513104890138-7c749659a591") },
  // Pasta
  { category: "Pasta", title: "Penne Arrabbiata", priceCents: 1050, description: "Spicy tomato sauce, garlic, parsley", image: photo("1621996346565-e3dbc646d9a9") },
  { category: "Pasta", title: "Spaghetti Carbonara", priceCents: 1200, description: "Guanciale, egg yolk, pecorino", image: photo("1612874742237-6526221588e3"), popular: true },
  { category: "Pasta", title: "Tagliatelle Beef Ragù", priceCents: 1350, description: "Slow-cooked beef, mushrooms, cream", image: photo("1551183053-bf91a1d81141") },
  // Burgers
  { category: "Burgers", title: "Classic Burger", priceCents: 1250, description: "Beef, cheddar, lettuce, tomato, house sauce", image: photo("1571091718767-18b5b1457add") },
  { category: "Burgers", title: "Double Cheeseburger", priceCents: 1490, description: "Two beef patties, double cheese", image: photo("1568901346375-23c9450c58cd"), popular: true },
  { category: "Burgers", title: "BBQ Burger", priceCents: 1390, description: "Smoky barbecue sauce, crispy onions", image: photo("1550547660-d9450f859349") },
  // Main Courses
  { category: "Main Courses", title: "Steak Frites", priceCents: 2400, description: "Rump steak, fries, herb butter", image: photo("1600891964092-4316c288032e"), popular: true },
  { category: "Main Courses", title: "BBQ Spare Ribs", priceCents: 1950, description: "Glazed pork ribs, coleslaw", image: photo("1544025162-d76694265947") },
  { category: "Main Courses", title: "Grilled Chicken", priceCents: 1650, description: "Chicken breast, seasonal vegetables", image: photo("1598515214211-89d3c73ae83b") },
  { category: "Main Courses", title: "Beef Fillet", priceCents: 2900, description: "Fillet steak, red wine jus, broccolini", image: photo("1432139509613-5c4255815697") },
  // Sides
  { category: "Sides", title: "French Fries", priceCents: 400, description: "With sea salt", image: photo("1573080496219-bb080dd4f877") },
  { category: "Sides", title: "Side Salad", priceCents: 450, description: "Mixed leaves, orange, red onion", image: photo("1540189549336-e6e99c3679fe") },
  // Desserts
  { category: "Desserts", title: "Chocolate Cake", priceCents: 650, description: "Rich chocolate layers, ganache", image: photo("1578985545062-69928b1d9587"), popular: true },
  { category: "Desserts", title: "Panna Cotta", priceCents: 600, description: "Vanilla cream, fresh strawberries", image: photo("1488477181946-6428a0291777") },
  { category: "Desserts", title: "Chocolate Sundae", priceCents: 700, description: "Ice cream, chocolate sauce, cookies", image: photo("1563805042-7684c019e1cb") },
  // Soft Drinks
  { category: "Soft Drinks", title: "Coca-Cola 0.33l", priceCents: 350, image: photo("1554866585-cd94860890b7") },
  { category: "Soft Drinks", title: "Fresh Orange Juice", priceCents: 450, description: "Freshly squeezed", image: photo("1600271886742-f049cd451bba") },
  { category: "Soft Drinks", title: "Homemade Iced Tea", priceCents: 400, description: "Black tea, lemon, mint", image: photo("1556679343-c7306c1976bc") },
  // Hot Drinks
  { category: "Hot Drinks", title: "Cappuccino", priceCents: 380, image: photo("1541167760496-1628856ab772"), popular: true },
  { category: "Hot Drinks", title: "Flat White", priceCents: 400, image: photo("1509042239860-f550ce710b93") },
  { category: "Hot Drinks", title: "Iced Latte", priceCents: 450, image: photo("1461023058943-07fcbe16d735") },
  // Beer
  { category: "Beer", title: "Lager 0.5l", priceCents: 490, image: photo("1608270586620-248524c67de9"), popular: true },
  { category: "Beer", title: "Draught Pils 0.4l", priceCents: 450, image: photo("1535958636474-b021ee887b13") },
  // Wine
  { category: "Wine", title: "House Red 0.2l", priceCents: 550, description: "Merlot", image: photo("1510812431401-41d2bd2722f3") },
  { category: "Wine", title: "Chianti 0.2l", priceCents: 650, description: "Tuscany, Italy", image: photo("1553361371-9b22f78e8b1d") },
  // Cocktails
  { category: "Cocktails", title: "Old Fashioned", priceCents: 1050, description: "Bourbon, bitters, orange", image: photo("1514362545857-3bc16c4c7d1b") },
  { category: "Cocktails", title: "Mojito", priceCents: 950, description: "Rum, lime, mint, soda", image: photo("1551538827-9c037cb4f32a"), popular: true },
  { category: "Cocktails", title: "Margarita", priceCents: 950, description: "Tequila, lime, triple sec", image: photo("1544145945-f90425340c7e") },
];
