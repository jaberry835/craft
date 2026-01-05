# Research Round Time Limits

## Overview

The multi-agent research system now includes configurable time limits per research round to prevent runaway queries and provide users with periodic summaries.

## How It Works

### Default Behavior
- **Default Time Limit:** 4 minutes (240 seconds) per research round
- **Auto-Pause:** When the time limit is exceeded, the system automatically:
  1. Pauses the current research round
  2. Generates a progress summary of what has been discovered
  3. Returns control to the user with options to continue

### What Happens When Time Limit is Reached

When a research round exceeds the configured time limit, users receive:

```
⏱️ **Research Round Time Limit Reached**

The current research round has been running for 4.2 minutes, 
which exceeds the configured limit of 4.0 minutes.

**Progress Summary (Round 3/12):**
[Detailed summary of what has been discovered so far]

**Next Steps:**
- Ask a follow-up question to continue researching specific aspects
- Reply 'continue' to resume the research
- Or consider this complete if you have the information you need

💡 *Tip: You can adjust the time limit by setting RESEARCH_ROUND_TIME_LIMIT_SECONDS in your .env file*
```

## Configuration

### Environment Variable

Add to your `.env` file:

```bash
# Research Configuration
# Time limit per research round in seconds (default: 240 = 4 minutes)
RESEARCH_ROUND_TIME_LIMIT_SECONDS=240
```

### Common Configurations

| Use Case | Recommended Setting | Reasoning |
|----------|-------------------|-----------|
| **Quick queries** | `120` (2 minutes) | Forces faster, more focused research |
| **Standard research** | `240` (4 minutes) | Default - good balance |
| **Deep investigation** | `480` (8 minutes) | Allows extensive multi-agent exploration |
| **Complex analysis** | `600` (10 minutes) | For very complex queries requiring many steps |

## Example Scenarios

### Scenario 1: ADX Query with 100 Tables

**Problem:** Without time limits, the orchestrator might attempt to query all 100 tables sequentially, taking 30+ minutes.

**With Time Limit:**
- Research proceeds for 4 minutes
- System auto-pauses after discovering ~15-20 tables
- User receives summary: "Found data in Tables A, B, C... identified patterns X, Y, Z"
- User can decide: "Great! Focus on Table A" or "Continue exploring more tables"

### Scenario 2: Multi-Source Research

**Problem:** Orchestrator delegates to FictionalCompaniesAgent, ADXAgent, and DocumentAgent, each taking 2-3 minutes.

**With Time Limit:**
- First delegation to FictionalCompaniesAgent: 2 minutes
- Second delegation to ADXAgent: 2 minutes
- **Time limit reached (4 minutes total)**
- User gets summary of findings from both agents
- User can ask: "Now check the documents" to continue

## Benefits

1. **Prevents Runaway Queries:** No more 20-minute research sessions that become too broad
2. **User Control:** Users get periodic checkpoints to redirect or refine the research
3. **Cost Management:** Limits token usage per round
4. **Better UX:** Users aren't left waiting indefinitely
5. **Iterative Refinement:** Encourages focused, iterative exploration

## Technical Details

### Implementation

The timer starts at the beginning of each research session and checks elapsed time before each round:

```python
round_start_time = time.time()

while round_num < max_rounds:
    elapsed_time = time.time() - round_start_time
    if elapsed_time > round_time_limit:
        # Auto-pause and summarize
        return progress_summary_with_options
```

### When Does the Check Occur?

- **Before each round** of orchestrator invocation
- **After** the current agent delegation completes
- This ensures in-flight agent calls complete before pausing

### What Counts Toward Time?

- Agent delegation time (e.g., ADXAgent querying databases)
- Orchestrator thinking time (LLM processing)
- Network latency between agents

### What Doesn't Count?

- User thinking time between messages
- Time between research sessions

## Adjusting for Your Needs

### For Fast-Paced Users
Set a shorter limit to get frequent summaries:
```bash
RESEARCH_ROUND_TIME_LIMIT_SECONDS=120  # 2 minutes
```

### For Patient Users
Set a longer limit for more comprehensive initial research:
```bash
RESEARCH_ROUND_TIME_LIMIT_SECONDS=600  # 10 minutes
```

### Disabling (Not Recommended)
To effectively disable time limits:
```bash
RESEARCH_ROUND_TIME_LIMIT_SECONDS=3600  # 1 hour (very high)
```

⚠️ **Warning:** Setting very high limits may result in:
- High token costs
- Long wait times
- Potential timeouts
- User frustration

## Future Enhancements

Potential improvements being considered:

- [ ] Per-agent time budgets
- [ ] Dynamic time limits based on complexity
- [ ] User-configurable limits per query
- [ ] Token budget tracking alongside time limits
- [ ] Automatic research scoping based on time remaining

## Troubleshooting

### "Research keeps pausing too quickly"
- Increase `RESEARCH_ROUND_TIME_LIMIT_SECONDS`
- Consider if the query is too broad and needs refinement

### "Research runs too long before pausing"
- Decrease `RESEARCH_ROUND_TIME_LIMIT_SECONDS`
- Check if individual agent calls are taking too long

### "I want to disable auto-pause"
- Set a very high value (e.g., 3600 seconds)
- Note: This may lead to very long research sessions
