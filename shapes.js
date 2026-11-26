// One entry per construction, not per color, proportion or printed character.
export const shapes=[
 {id:'classic',name:'Lift-off lid',family:'Everyday',use:'Gifts, keepsakes, small brands',size:[90,65,40],icon:'classic'},
 {id:'tuck',name:'Tuck carton',family:'Everyday',use:'Skincare, candles, small products',size:[65,45,100],icon:'tuck'},
 {id:'mailer',name:'Mailer',family:'Everyday',use:'Small-batch deliveries',size:[120,85,35],icon:'mailer'},
 {id:'display',name:'Display tray',family:'Retail',use:'Counter displays and gift sets',size:[110,75,35],icon:'display'},
 {id:'book',name:'Book flap',family:'Gift',use:'Premium sets and presentation',size:[105,75,40],icon:'book'},
 {id:'drawer',name:'Drawer & sleeve',family:'Gift',use:'Jewelry and little discoveries',size:[95,65,30],icon:'drawer'},
 {id:'gable',name:'Gable handle',family:'Carry',use:'Party favors, treats and gifts',size:[85,55,85],icon:'gable'},
 {id:'carrier',name:'Carry case',family:'Carry',use:'Gift kits with a flat handle',size:[105,45,75],icon:'carrier'},
 {id:'house',name:'Little house',family:'Gift',use:'Playful gifts and advent surprises',size:[70,60,75],icon:'house'},
 {id:'hangtab',name:'Hanging carton',family:'Retail',use:'Accessories and peg displays',size:[65,30,95],icon:'hangtab'},
 {id:'hexagon',name:'Hexagon',family:'Gift',use:'Candles, treats and keepsakes',size:[85,75,65],icon:'hexagon'},
 {id:'octagon',name:'Octagon',family:'Gift',use:'Confectionery and special gifts',size:[90,80,45],icon:'octagon'},
 {id:'pyramid',name:'Pyramid',family:'Gift',use:'Tiny gifts with a big silhouette',size:[80,70,85],icon:'pyramid'},
 {id:'wedge',name:'Triangle wedge',family:'Food',use:'Sandwiches and triangular gifts',size:[80,65,90],icon:'wedge'},
 {id:'envelope',name:'Envelope pouch',family:'Gift',use:'Cards, flat gifts and stationery',size:[85,30,100],icon:'envelope'},
 {id:'sleeve',name:'Open sleeve',family:'Retail',use:'A printed wrap for your own tray',size:[105,65,35],icon:'sleeve'},
 {id:'takeout',name:'Takeout',family:'Food',use:'Snacks and little food gifts',size:[100,75,60],icon:'takeout'},
 {id:'tray',name:'Open tray',family:'Everyday',use:'Organized gift sets and small goods',size:[110,80,30],icon:'tray'},
];
export const shapeById=id=>shapes.find(x=>x.id===id)||shapes[0];
