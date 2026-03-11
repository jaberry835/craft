BOT_NAME = "webscraper"

SPIDER_MODULES = ["webscraper.spiders"]
NEWSPIDER_MODULE = "webscraper.spiders"

# Be polite
ROBOTSTXT_OBEY = True

CONCURRENT_REQUESTS = 4
DOWNLOAD_DELAY = 1

REQUEST_FINGERPRINTER_IMPLEMENTATION = "2.7"
TWISTED_REACTOR = "twisted.internet.asyncioreactor.AsyncioSelectorReactor"
FEED_EXPORT_ENCODING = "utf-8"

LOG_LEVEL = "INFO"
