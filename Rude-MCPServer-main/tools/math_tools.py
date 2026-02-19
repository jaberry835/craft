"""
Math Tools for Rude MCP Server
Mathematical calculation tools and statistical functions
"""

import logging
import math
import statistics
from typing import List, Dict
from fastmcp import FastMCP

logger = logging.getLogger(__name__)

def register_math_tools(mcp: FastMCP):
    """Register all math tools with the FastMCP server"""
    
    @mcp.tool
    def add(a: float, b: float) -> float:
        """Add two numbers together"""
        result = a + b
        logger.info(f"Math operation: {a} + {b} = {result}")
        return result

    @mcp.tool
    def subtract(a: float, b: float) -> float:
        """Subtract second number from first number"""
        result = a - b
        logger.info(f"Math operation: {a} - {b} = {result}")
        return result

    @mcp.tool
    def multiply(a: float, b: float) -> float:
        """Multiply two numbers together"""
        result = a * b
        logger.info(f"Math operation: {a} * {b} = {result}")
        return result

    @mcp.tool
    def divide(a: float, b: float) -> float:
        """Divide first number by second number"""
        if b == 0:
            raise ValueError("Cannot divide by zero")
        result = a / b
        logger.info(f"Math operation: {a} / {b} = {result}")
        return result

    @mcp.tool
    def power(base: float, exponent: float) -> float:
        """Raise base to the power of exponent"""
        result = math.pow(base, exponent)
        logger.info(f"Math operation: {base} ^ {exponent} = {result}")
        return result

    @mcp.tool
    def square_root(number: float) -> float:
        """Calculate square root of a number"""
        if number < 0:
            raise ValueError("Cannot calculate square root of negative number")
        result = math.sqrt(number)
        logger.info(f"Math operation: sqrt({number}) = {result}")
        return result

    @mcp.tool
    def calculate_statistics(numbers: List[float]) -> Dict[str, float]:
        """Calculate basic statistics for a list of numbers"""
        if not numbers:
            raise ValueError("Cannot calculate statistics for empty list")
        
        result = {
            "count": len(numbers),
            "sum": sum(numbers),
            "mean": statistics.mean(numbers),
            "median": statistics.median(numbers),
            "min": min(numbers),
            "max": max(numbers)
        }
        
        if len(numbers) > 1:
            result["stdev"] = statistics.stdev(numbers)
            result["variance"] = statistics.variance(numbers)
        
        logger.info(f"Statistics calculated for {len(numbers)} numbers")
        return result

    @mcp.tool
    def factorial(n: int) -> int:
        """Calculate factorial of a non-negative integer"""
        if n < 0:
            raise ValueError("Factorial is not defined for negative numbers")
        if n > 170:  # Prevent overflow
            raise ValueError("Number too large for factorial calculation")
        
        result = math.factorial(n)
        logger.info(f"Math operation: {n}! = {result}")
        return result

    logger.info("Math tools registered successfully")
