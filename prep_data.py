import pandas as pd
import json
import os

def prep_data():
    print("Reading CSV file (this might take a few seconds)...")
    csv_path = 'upi_transactions_2024.csv'
    if not os.path.exists(csv_path):
        print(f"Error: {csv_path} not found.")
        return

    df = pd.read_csv(csv_path)
    print("Parsing timestamps...")
    df['date'] = pd.to_datetime(df['timestamp']).dt.date
    
    # Filter for SUCCESS transactions only
    df_success = df[df['transaction_status'] == 'SUCCESS'].copy()
    
    # Define date range
    start_date = pd.to_datetime('2024-01-01').date()
    end_date = pd.to_datetime('2024-12-31').date()
    all_dates = pd.date_range(start=start_date, end=end_date).date
    
    # We will build a dictionary of results
    # Structure:
    # {
    #   "groups": {
    #      "overall": {
    #         "data": [ { "date": "2024-01-01", "inflow": X, "outflow": Y, "categories": { ... } }, ... ]
    #      },
    #      "state_Maharashtra": { ... },
    #      "bank_SBI": { ... }
    #   },
    #   "metadata": {
    #      "states": [...],
    #      "banks": [...]
    #   }
    # }
    output_data = {
        "groups": {},
        "metadata": {
            "states": sorted(df_success['sender_state'].dropna().unique().tolist()),
            "banks": sorted(df_success['sender_bank'].dropna().unique().tolist())
        }
    }
    
    # Helper function to generate time series for a dataframe subset
    def aggregate_subset(sub_df, name):
        print(f"Aggregating {name}...")
        # Daily pivot for transaction types
        # Transaction types: P2P, P2M, Bill Payment, Recharge
        daily_types = sub_df.pivot_table(
            index='date', 
            columns='transaction type', 
            values='amount (INR)', 
            aggfunc='sum'
        ).fillna(0)
        
        # Ensure all types exist in columns
        for t in ['P2P', 'P2M', 'Bill Payment', 'Recharge']:
            if t not in daily_types.columns:
                daily_types[t] = 0.0
                
        # Daily pivot for categories
        daily_cats = sub_df.pivot_table(
            index='date',
            columns='merchant_category',
            values='amount (INR)',
            aggfunc='sum'
        ).fillna(0)
        
        # Transaction count
        daily_counts = sub_df.groupby('date').size()
        
        # Merge all into a complete date series
        records = []
        for dt in all_dates:
            dt_str = dt.isoformat()
            
            # Inflow = P2P
            inflow = float(daily_types.loc[dt, 'P2P']) if dt in daily_types.index else 0.0
            
            # Outflow = P2M + Bill Payment + Recharge
            outflow = 0.0
            if dt in daily_types.index:
                outflow += float(daily_types.loc[dt, 'P2M'])
                outflow += float(daily_types.loc[dt, 'Bill Payment'])
                outflow += float(daily_types.loc[dt, 'Recharge'])
            
            # Categories
            cats_dict = {}
            if dt in daily_cats.index:
                row = daily_cats.loc[dt]
                for cat in row.index:
                    cats_dict[cat] = float(row[cat])
            
            # Tx count
            tx_count = int(daily_counts.loc[dt]) if dt in daily_counts.index else 0
            
            records.append({
                "date": dt_str,
                "inflow": inflow,
                "outflow": outflow,
                "categories": cats_dict,
                "tx_count": tx_count
            })
            
        output_data["groups"][name] = records

    # 1. Aggregate Overall
    aggregate_subset(df_success, "overall")
    
    # 2. Aggregate by State
    for state in output_data["metadata"]["states"]:
        state_df = df_success[df_success['sender_state'] == state]
        aggregate_subset(state_df, f"state_{state}")
        
    # 3. Aggregate by Bank
    for bank in output_data["metadata"]["banks"]:
        bank_df = df_success[df_success['sender_bank'] == bank]
        aggregate_subset(bank_df, f"bank_{bank}")
        
    # Write to file
    out_path = 'daily_cashflow_data.json'
    print(f"Writing output to {out_path}...")
    with open(out_path, 'w') as f:
        json.dump(output_data, f, indent=2)
    print("Data preparation complete!")

if __name__ == '__main__':
    prep_data()
