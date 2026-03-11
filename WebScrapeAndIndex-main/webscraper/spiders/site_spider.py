import scrapy
from urllib.parse import urlparse


class SiteSpider(scrapy.Spider):
    """Crawls a website and extracts text content from each page."""

    name = "site_spider"

    def __init__(self, url: str, max_pages: int = 100, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.start_urls = [url]
        self.max_pages = int(max_pages)  # 0 = no limit
        self.pages_crawled = 0

        parsed = urlparse(url)
        self.allowed_domains = [parsed.netloc]

    def parse(self, response):
        if self.max_pages and self.pages_crawled >= self.max_pages:
            return

        self.pages_crawled += 1

        # Extract visible text content from the page
        title = response.css("title::text").get(default="").strip()

        # Gather text from common content areas, skip nav/footer/script/style
        text_parts = []
        for selector in ["article", "main", "[role='main']", ".content", "#content", "body"]:
            texts = response.css(f"{selector} *::text").getall()
            if texts:
                text_parts = texts
                break

        if not text_parts:
            text_parts = response.css("body *::text").getall()

        # Clean up whitespace
        content = " ".join(t.strip() for t in text_parts if t.strip())

        if content:
            yield {
                "url": response.url,
                "title": title,
                "content": content,
            }

        # Follow internal links
        for href in response.css("a::attr(href)").getall():
            if not self.max_pages or self.pages_crawled < self.max_pages:
                yield response.follow(href, callback=self.parse)
