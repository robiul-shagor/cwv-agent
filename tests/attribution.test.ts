import { describe, expect, it } from 'vitest';
import { attributeUrl, siteOf } from '../src/lib/attribution.js';

const page = 'https://www.shop.co.uk/products/x';

describe('attributeUrl', () => {
  it.each([
    [
      'https://www.shop.co.uk/wp-content/plugins/elementor-pro/assets/js/frontend.min.js?ver=3.2',
      'wp-plugin:elementor-pro',
    ],
    ['https://cdn.shop.co.uk/wp-content/themes/astra/style.css', 'wp-theme:astra'],
    ['https://www.shop.co.uk/wp-includes/js/jquery/jquery.min.js', 'wp-core'],
    ['https://www.shop.co.uk/wp-content/cache/min/1/abc.js', 'wp-optimizer-bundle:WP Rocket'],
    ['https://www.shop.co.uk/wp-content/litespeed/js/abc.js', 'wp-optimizer-bundle:LiteSpeed Cache'],
    [
      'https://www.shop.co.uk/wp-content/uploads/elementor/css/post-12.css',
      'wp-plugin:elementor (generated)',
    ],
    [
      'https://cdn.shopify.com/extensions/0193-ab/judgeme-reviews-142/assets/widget.js',
      'shopify-app:judgeme-reviews',
    ],
    ['https://www.shop.co.uk/cdn/shop/t/12/assets/theme.js?v=1', 'shopify-theme'],
    ['https://cdn.shopify.com/s/files/1/0123/4567/t/3/assets/global.js', 'shopify-theme'],
    ['https://www.shop.co.uk/modules/contrib/slick/js/slick.js', 'drupal-module:slick'],
    [
      'https://www.shop.co.uk/static/version1700/frontend/Acme/luma/en_US/Magento_Catalog/js/gallery.js',
      'magento-module:Magento_Catalog',
    ],
    ['https://www.shop.co.uk/media/com_virtuemart/js/vm.js', 'joomla-extension:com_virtuemart'],
    ['https://www.googletagmanager.com/gtm.js?id=GTM-1', 'vendor:Google Tag Manager'],
    ['https://www.gstatic.com/recaptcha/releases/x/recaptcha__en.js', 'vendor:reCAPTCHA'],
    ['https://static.hotjar.com/c/hotjar-1.js', 'vendor:Hotjar'],
    ['https://img.shop.co.uk/hero.avif', 'first-party'],
    ['https://cdn.unknownvendor.io/x.js', 'third-party:cdn.unknownvendor.io'],
  ])('%s → %s', (url, owner) => {
    expect(attributeUrl(url, page)).toBe(owner);
  });

  it('ignores non-http URLs and computes registrable domains', () => {
    expect(attributeUrl('data:image/png;base64,xx', page)).toBeUndefined();
    expect(siteOf('a.b.example.com')).toBe('example.com');
    expect(siteOf('www.shop.co.uk')).toBe('shop.co.uk');
  });
});
