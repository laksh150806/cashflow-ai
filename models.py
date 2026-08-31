from sqlalchemy import Column, Integer, String, Float, DateTime, ForeignKey, JSON
from sqlalchemy.orm import relationship
from datetime import datetime
from database import Base


class Business(Base):
    __tablename__ = "businesses"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    sector = Column(String, nullable=True)
    registration_date = Column(DateTime, default=datetime.utcnow)

    transactions = relationship("Transaction", back_populates="business")
    credit_scores = relationship("CreditScore", back_populates="business")
    forecasts = relationship("CashFlowForecast", back_populates="business")
    alerts = relationship("Alert", back_populates="business")


class Transaction(Base):
    __tablename__ = "transactions"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"))
    date = Column(DateTime, nullable=False)
    amount = Column(Float, nullable=False)
    type = Column(String, nullable=False)       # "inflow" or "outflow"
    category = Column(String, nullable=True)    # e.g. "sales", "rent", "supplies"
    balance_after = Column(Float, nullable=True)

    business = relationship("Business", back_populates="transactions")


class CreditScore(Base):
    __tablename__ = "credit_scores"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"))
    score = Column(Float, nullable=False)        # 0-100
    computed_at = Column(DateTime, default=datetime.utcnow)
    risk_factors = Column(JSON, nullable=True)    # e.g. {"volatility": "high", ...}

    business = relationship("Business", back_populates="credit_scores")


class CashFlowForecast(Base):
    __tablename__ = "cash_flow_forecasts"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"))
    forecast_date = Column(DateTime, nullable=False)
    predicted_inflow = Column(Float, nullable=True)
    predicted_outflow = Column(Float, nullable=True)
    predicted_balance = Column(Float, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    business = relationship("Business", back_populates="forecasts")


class Alert(Base):
    __tablename__ = "alerts"

    id = Column(Integer, primary_key=True, index=True)
    business_id = Column(Integer, ForeignKey("businesses.id"))
    alert_type = Column(String, nullable=False)   # e.g. "cash_crunch"
    message = Column(String, nullable=False)
    triggered_at = Column(DateTime, default=datetime.utcnow)

    business = relationship("Business", back_populates="alerts")
